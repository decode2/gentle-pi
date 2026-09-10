import type { ExtensionAPI, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveGentlePiAgentHome } from "../lib/agent-home.ts";
import { readQuestionOwnerConfig, type QuestionOwnerConfigResolution } from "../lib/questions/owner-config.ts";
import { createTuiQuestionPresentationDriver } from "../lib/questions/tui-presentation-driver.ts";
import type { QuestionPresentationDriver, QuestionnaireFailure, QuestionnaireToolResult } from "../lib/questions/contract.ts";
import { validateAndFormat } from "../lib/questions/response.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

const TOOL_NAME = "ask_user_question";
const BLOCKED_EVENT = "rpiv:ask-user:blocked";

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

export interface AskUserQuestionDependencies {
	resolveAgentHome: () => string;
	readOwnerConfig: (agentHome: string) => Promise<QuestionOwnerConfigResolution>;
	createPresentationDriver: (ui: Pick<ExtensionUIContext, "custom">) => QuestionPresentationDriver;
}

const defaultDependencies: AskUserQuestionDependencies = {
	resolveAgentHome: resolveGentlePiAgentHome,
	readOwnerConfig: readQuestionOwnerConfig,
	createPresentationDriver: createTuiQuestionPresentationDriver,
};

/** Factory seam for owner-safe, host-free extension tests. */
export function createAskUserQuestionExtension(
	dependencies: AskUserQuestionDependencies = defaultDependencies,
): (pi: ExtensionAPI) => void {
	let registered = false;
	let busy = false;

	return function askUserQuestion(pi: ExtensionAPI): void {
		pi.on("session_start", async (_event, ctx) => {
			if (registered || ctx.mode !== "tui") return;
			let owner: QuestionOwnerConfigResolution;
			try {
				owner = await dependencies.readOwnerConfig(dependencies.resolveAgentHome());
			} catch {
				return;
			}
			if (!owner.allowRegistration) return;
			if (pi.getAllTools().some((tool) => tool.name === TOOL_NAME)) return;

			pi.registerTool(questionnaireTool(pi, dependencies, () => busy, (value) => { busy = value; }));
			registered = true;
			// Pi exposes no atomic reserve operation; a later dynamic collision remains host-owned.
		});
	};
}

function questionnaireTool(
	pi: ExtensionAPI,
	dependencies: AskUserQuestionDependencies,
	isBusy: () => boolean,
	setBusy: (value: boolean) => void,
): ToolDefinition<typeof ParametersSchema, QuestionnaireToolResult["details"]> {
	return {
		name: TOOL_NAME,
		label: "Ask User Question",
		description: "Ask the user one to four structured questions in the interactive TUI.",
		parameters: ParametersSchema,
		executionMode: "sequential",
		async execute(toolCallId, params, signal, _onUpdate, ctx) {
			if (ctx.mode !== "tui") throw new Error("ask_user_question is unavailable outside the interactive TUI");
			if (isBusy()) throw new Error("ask_user_question is already active");
			setBusy(true);
			try {
				pi.events.emit(BLOCKED_EVENT, { active: true });
				const frozen = createFrozenQuestionnaireRequest(toolCallId, params);
				if (!frozen.ok) return inputFailure(frozen.failure);
				const outcome = await dependencies.createPresentationDriver(ctx.ui).present(frozen.request, signal);
				return validateAndFormat(frozen.request, outcome).result;
			} finally {
				setBusy(false);
				pi.events.emit(BLOCKED_EVENT, { active: false });
			}
		},
	};
}

function inputFailure(failure: QuestionnaireFailure): QuestionnaireToolResult {
	return {
		content: [{ type: "text", text: `Error: ${failure.message}` }],
		details: { answers: [], cancelled: true, error: failure.code },
	};
}

export default createAskUserQuestionExtension();
