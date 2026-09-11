import type { ExtensionAPI, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import { readQuestionOwnerConfig, type QuestionOwnerConfigResolution } from "../lib/questions/owner-config.ts";
import { readQuestionnaireGuidanceConfig, type QuestionnaireGuidance } from "../lib/questions/guidance-config.ts";
import { createRpcQuestionPresentationDriver } from "../lib/questions/rpc-presentation-driver.ts";
import { createTuiQuestionPresentationDriver } from "../lib/questions/tui-presentation-driver.ts";
import {
	MAX_HEADER_LENGTH, MAX_LABEL_LENGTH, MAX_OPTIONS, MAX_QUESTIONS, MIN_OPTIONS, RESERVED_LABELS,
	type QuestionPresentationDriver, type QuestionnaireFailure, type QuestionnaireToolResult,
} from "../lib/questions/contract.ts";
import { validateAndFormat } from "../lib/questions/response.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

const TOOL_NAME = "ask_user_question";
const PROMPT_EVENT = "rpiv:ask-user:prompt";
const BLOCKED_EVENT = "rpiv:ask-user:blocked";
const LEGACY_RESERVED_LABELS = new Set<string>(RESERVED_LABELS);
const LEGACY_FAILURES = {
	no_questions: { code: "no_questions", message: "At least one question is required" },
	too_many_questions: { code: "too_many_questions", message: "At most 4 questions are allowed per invocation" },
	duplicate_question: { code: "duplicate_question", message: "Question text must be unique within an invocation" },
	empty_options: { code: "empty_options", message: "Each question requires at least 2 options" },
	reserved_label: { code: "reserved_label", message: "Option label is reserved (Other, Type something., Next)" },
	duplicate_option_label: { code: "duplicate_option_label", message: "Option labels must be unique within a question" },
	no_ui: { code: "no_ui", message: "UI not available (running in non-interactive mode)" },
} as const;

type LegacyFailure = (typeof LEGACY_FAILURES)[keyof typeof LEGACY_FAILURES];
type LegacyQuestion = { question: string; header: string; options: LegacyOption[]; multiSelect?: boolean };
type LegacyOption = { label: string; description: string; preview?: string };

const OptionSchema = Type.Object({
	label: Type.String({ maxLength: 60 }),
	description: Type.String(),
	preview: Type.Optional(Type.String()),
}, { additionalProperties: false });

const QuestionSchema = Type.Object({
	question: Type.String(),
	header: Type.String({ maxLength: 16 }),
	options: Type.Array(OptionSchema, { minItems: 2, maxItems: 4 }),
	multiSelect: Type.Optional(Type.Boolean()),
}, { additionalProperties: false });

const ParametersSchema = Type.Object({
	questions: Type.Array(QuestionSchema, { minItems: 1, maxItems: 4 }),
}, { additionalProperties: false });

type QuestionnaireUi = Pick<ExtensionUIContext, "custom" | "select" | "editor">;
type QuestionnaireMode = "tui" | "rpc";

export interface AskUserQuestionDependencies {
	resolveAgentHome: () => string;
	readOwnerConfig: (agentHome: string) => Promise<QuestionOwnerConfigResolution>;
	readGuidanceConfig?: (agentHome: string) => Promise<QuestionnaireGuidance>;
	createPresentationDriver: (ui: QuestionnaireUi, mode: QuestionnaireMode) => QuestionPresentationDriver;
}

const defaultDependencies: AskUserQuestionDependencies = {
	resolveAgentHome: resolveGentlePiAgentHome,
	readOwnerConfig: readQuestionOwnerConfig,
	readGuidanceConfig: readQuestionnaireGuidanceConfig,
	createPresentationDriver: (ui, mode) => mode === "rpc"
		? createRpcQuestionPresentationDriver(ui)
		: createTuiQuestionPresentationDriver(ui),
};

/** Factory seam for owner-safe, host-free extension tests. */
export function createAskUserQuestionExtension(
	dependencies: AskUserQuestionDependencies = defaultDependencies,
): (pi: ExtensionAPI) => void {
	let registered = false;
	let busy = false;

	return function askUserQuestion(pi: ExtensionAPI): void {
		pi.on("session_start", async (_event, ctx) => {
			if (registered || !supportedMode(ctx)) return;
			let agentHome: string;
			let owner: QuestionOwnerConfigResolution;
			try {
				agentHome = dependencies.resolveAgentHome();
				owner = await dependencies.readOwnerConfig(agentHome);
			} catch {
				return;
			}
			if (!owner.allowRegistration) return;
			if (pi.getAllTools().some((tool) => tool.name === TOOL_NAME)) return;

			let guidance: QuestionnaireGuidance = {};
			try {
				guidance = await dependencies.readGuidanceConfig?.(agentHome) ?? {};
			} catch {
				// Optional guidance must not override an admitted owner decision.
			}
			pi.registerTool(questionnaireTool(pi, dependencies, guidance, () => busy, (value) => { busy = value; }));
			registered = true;
			// Pi exposes no atomic reserve operation; a later dynamic collision remains host-owned.
		});
	};
}

function questionnaireTool(
	pi: ExtensionAPI,
	dependencies: AskUserQuestionDependencies,
	guidance: QuestionnaireGuidance,
	isBusy: () => boolean,
	setBusy: (value: boolean) => void,
): ToolDefinition<typeof ParametersSchema, QuestionnaireToolResult["details"]> {
	return {
		name: TOOL_NAME,
		label: "Ask User Question",
		description: guidance.description ?? "Ask the user one to four structured questions in the interactive TUI.",
		...(guidance.promptSnippet === undefined ? {} : { promptSnippet: guidance.promptSnippet }),
		...(guidance.promptGuidelines === undefined ? {} : { promptGuidelines: guidance.promptGuidelines }),
		parameters: ParametersSchema,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (!supportedMode(ctx)) return errorResult(LEGACY_FAILURES.no_ui);
			if (isBusy()) throw new Error("ask_user_question is already active");
			const frozen = createFrozenQuestionnaireRequest(toolCallId, params);
			if (!frozen.ok) return legacyInputFailure(params, frozen.failure);
			setBusy(true);
			try {
				pi.events.emit(PROMPT_EVENT, {
					questions: frozen.request.questions.map((question) => ({
						question: question.question,
						header: question.header,
						multiSelect: question.multiSelect,
						options: question.options.map((option) => ({
							label: option.label,
							description: option.description,
							hasPreview: Boolean(option.preview),
						})),
					})),
				});
				pi.events.emit(BLOCKED_EVENT, { active: true });
				const outcome = await dependencies.createPresentationDriver(ctx.ui, ctx.mode).present(frozen.request, signal);
				return validateAndFormat(frozen.request, outcome).result;
			} finally {
				setBusy(false);
				pi.events.emit(BLOCKED_EVENT, { active: false });
			}
		},
	};
}

function supportedMode(ctx: { mode: string; hasUI?: boolean; ui: QuestionnaireUi }): ctx is { mode: QuestionnaireMode; hasUI?: boolean; ui: QuestionnaireUi } {
	return ctx.mode === "tui" || ctx.mode === "rpc" && ctx.hasUI === true
		&& typeof ctx.ui.select === "function" && typeof ctx.ui.editor === "function";
}

function legacyInputFailure(input: unknown, fallback: QuestionnaireFailure): QuestionnaireToolResult {
	return errorResult(legacyFailure(input) ?? fallback);
}

function errorResult(failure: { code: string; message: string }): QuestionnaireToolResult {
	return {
		content: [{ type: "text", text: `Error: ${failure.message}` }],
		details: { answers: [], cancelled: true, error: failure.code },
	};
}

function legacyFailure(input: unknown): LegacyFailure | undefined {
	if (!record(input) || !Array.isArray(input.questions)) return undefined;
	if (input.questions.length === 0) return LEGACY_FAILURES.no_questions;
	if (!Array.from(input.questions).every(legacyQuestion)) return undefined;
	if (input.questions.length > MAX_QUESTIONS) return LEGACY_FAILURES.too_many_questions;

	const seenQuestions = new Set<string>();
	for (const question of input.questions) {
		if (seenQuestions.has(question.question)) return LEGACY_FAILURES.duplicate_question;
		seenQuestions.add(question.question);
	}
	for (const question of input.questions) {
		if (question.options.length < MIN_OPTIONS) return LEGACY_FAILURES.empty_options;
		const seenLabels = new Set<string>();
		for (const option of question.options) {
			if (LEGACY_RESERVED_LABELS.has(option.label)) return LEGACY_FAILURES.reserved_label;
			if (seenLabels.has(option.label)) return LEGACY_FAILURES.duplicate_option_label;
			seenLabels.add(option.label);
		}
	}
	return undefined;
}

function legacyQuestion(value: unknown): value is LegacyQuestion {
	if (!record(value) || typeof value.question !== "string" || typeof value.header !== "string" || !Array.isArray(value.options)) return false;
	if (value.header.length > MAX_HEADER_LENGTH || value.options.length > MAX_OPTIONS) return false;
	if (has(value, "multiSelect") && typeof value.multiSelect !== "boolean") return false;
	return Array.from(value.options).every(legacyOption);
}

function legacyOption(value: unknown): value is LegacyOption {
	return record(value) && typeof value.label === "string" && value.label.length <= MAX_LABEL_LENGTH
		&& typeof value.description === "string" && (!has(value, "preview") || typeof value.preview === "string");
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function has(value: Record<string, unknown>, key: string): boolean {
	return Object.hasOwn(value, key);
}

export default createAskUserQuestionExtension();
