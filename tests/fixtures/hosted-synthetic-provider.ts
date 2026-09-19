import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createAssistantMessageEventStream, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type ToolCall, type ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "hosted-questionnaire-synthetic";
const MODEL_ID = "hosted-questionnaire-model";
const API_ID = "hosted-questionnaire-stream-v1";
const TOOL_NAME = "ask_user_question";
const TOOL_CALL_ID = "hosted-questionnaire-call-1";
const PROMPT_EVENT = "rpiv:ask-user:prompt";
const BLOCKED_EVENT = "rpiv:ask-user:blocked";
const QUESTION = "Which layout should we inspect?";
const SECOND_QUESTION = "Which spacing should we inspect?";
const THIRD_QUESTION = "Which options should we compare?";
const CUSTOM_ANSWER = "  leading  internal\ntrailing  ";
const DECLINE_MESSAGE = "User declined to answer questions";
const FINAL_TEXT = {
	cancel: "Synthetic provider completed after questionnaire cancellation.",
	single: "Synthetic provider completed after questionnaire single selection.",
	custom: "Synthetic provider completed after questionnaire custom response.",
	multi: "Synthetic provider completed after questionnaire multi selection.",
	"empty-multi": "Synthetic provider completed after questionnaire empty multi selection.",
	"partial-cancel": "Synthetic provider completed after questionnaire partial cancellation.",
	"schema-positive": "Synthetic provider completed after questionnaire schema-positive cancellation.",
	"invalid-missing-questions": "Synthetic provider completed after missing-questions schema rejection.",
	"invalid-empty-questions": "Synthetic provider completed after empty-questions schema rejection.",
	"invalid-one-option": "Synthetic provider completed after one-option schema rejection.",
} as const;
const MARKERS = { session: "hosted:session_start", beforeAgent: "hosted:before_agent_start", registered: "hosted:ask_user_question:registered", invoked: "hosted:ask_user_question:invoked", toolCall: "hosted:ask_user_question:tool_call", validationError: "hosted:ask_user_question:validation-error", schema: "hosted:ask_user_question:schema:", cancelled: "hosted:ask_user_question:cancelled", completed: "hosted:ask_user_question:completed", prompt: "hosted:rpiv:ask-user:prompt", blocked: (active: boolean) => `hosted:rpiv:ask-user:blocked:${active}` } as const;
const HOSTED_SCENARIOS = ["cancel", "single", "custom", "multi", "empty-multi", "partial-cancel", "schema-positive", "invalid-missing-questions", "invalid-empty-questions", "invalid-one-option"] as const;
type HostedScenario = (typeof HOSTED_SCENARIOS)[number];
type InvalidScenario = "invalid-missing-questions" | "invalid-empty-questions" | "invalid-one-option";
type AnsweredScenario = Exclude<HostedScenario, "cancel" | "partial-cancel" | "schema-positive" | InvalidScenario>;
const SCHEMA_NOTIFICATION_MAX = 24_000;
const PROBE_INVENTORY_PREFIX = "hosted:questionnaire-inventory:";
const PROBE_INVENTORY_MAX = 8_000;
const PROVIDER_ENTRY_PREFIX = "hosted:questionnaire-provider-entry:";
const PROBE_COMMAND = "hosted-questionnaire-inventory-v1";
const RELOAD_MODE = process.env.GENTLE_PI_HOSTED_RELOAD === "1";
const RELOAD_TELEMETRY_PREFIX = "hosted:reload-telemetry:";
const PACKAGE_COMPOSITION_PREFIX = "hosted:package-composition:";
const PACKAGE_PROVIDER_INVENTORY_PREFIX = "hosted:package-provider-inventory:";
const HOSTED_PACKAGE_CASES = ["external-only", "candidate-only", "candidate-external-filtered"] as const;
const HOSTED_OWNER_PROFILES = ["gentle-pi", "missing", "legacy-external"] as const;
const HOSTED_PROBE_MODES = ["none", "inventory-negative"] as const;
type HostedOwnerProfile = (typeof HOSTED_OWNER_PROFILES)[number];
type HostedProbeMode = (typeof HOSTED_PROBE_MODES)[number];
type HostedPackageCase = (typeof HOSTED_PACKAGE_CASES)[number];
const GENERATION_KEY = Symbol.for("gentle-pi.hosted-questionnaire.synthetic-generation-v1");
function isInvalidScenario(scenario: HostedScenario): scenario is InvalidScenario { return scenario.startsWith("invalid-"); }

type FixtureState = {
	readonly generation: number;
	readonly toolCallId: string;
	questionIssued: boolean;
	notify?: (message: string) => void;
	observed: {
		session: boolean;
		beforeAgent: boolean;
		registered: boolean;
		invoked: boolean;
		toolCall: boolean;
		validationError: string | undefined;
		cancelled: boolean;
		completed: boolean;
		prompt: number;
		promptProjection: string | undefined;
		blocked: boolean[];
	};
};

function nextGeneration(): number {
	const processState = globalThis as typeof globalThis & Record<symbol, number | undefined>;
	const generation = (processState[GENERATION_KEY] ?? 0) + 1;
	processState[GENERATION_KEY] = generation;
	return generation;
}

function createState(generation: number): FixtureState {
	return {
		generation,
		toolCallId: RELOAD_MODE ? `hosted-questionnaire-call-${generation}` : TOOL_CALL_ID,
		questionIssued: false,
		observed: { session: false, beforeAgent: false, registered: false, invoked: false, toolCall: false, validationError: undefined, cancelled: false, completed: false, prompt: 0, promptProjection: undefined, blocked: [] },
	};
}
const OWNED_SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../extensions/ask-user-question.ts");
const REFERENCE_SOURCE_PATH = "/reference/node_modules/@juicesharp/rpiv-ask-user-question/index.ts";
const expectedSourcePath = process.env.GENTLE_PI_HOSTED_EXPECTED_SOURCE_PATH ?? OWNED_SOURCE_PATH;
if (expectedSourcePath !== OWNED_SOURCE_PATH && expectedSourcePath !== REFERENCE_SOURCE_PATH) throw new Error(`unsupported hosted questionnaire source path: ${expectedSourcePath}`);
const packageCaseValue = process.env.GENTLE_PI_HOSTED_PACKAGE_CASE;
if (packageCaseValue !== undefined && !(HOSTED_PACKAGE_CASES as readonly string[]).includes(packageCaseValue)) throw new Error(`unsupported hosted questionnaire package case: ${packageCaseValue}`);
const expectedPackageCase = packageCaseValue as HostedPackageCase | undefined;
if (expectedPackageCase !== undefined) {
	const expectedPackageSource = expectedPackageCase === "external-only" ? REFERENCE_SOURCE_PATH : OWNED_SOURCE_PATH;
	if (expectedSourcePath !== expectedPackageSource) throw new Error(`package case/source mismatch: ${expectedPackageCase} -> ${expectedSourcePath}`);
}
const scenarioValue = process.env.GENTLE_PI_HOSTED_SCENARIO;
if (scenarioValue !== undefined && !(HOSTED_SCENARIOS as readonly string[]).includes(scenarioValue)) throw new Error(`unsupported hosted questionnaire scenario: ${scenarioValue}`);
const expectedScenario: HostedScenario = (scenarioValue as HostedScenario | undefined) ?? "cancel";
const ownerProfileValue = process.env.GENTLE_PI_HOSTED_OWNER_PROFILE;
if (ownerProfileValue !== undefined && !(HOSTED_OWNER_PROFILES as readonly string[]).includes(ownerProfileValue)) throw new Error(`unsupported hosted owner profile: ${ownerProfileValue}`);
const expectedOwnerProfile: HostedOwnerProfile = (ownerProfileValue as HostedOwnerProfile | undefined) ?? "gentle-pi";
const probeModeValue = process.env.GENTLE_PI_HOSTED_PROBE_MODE;
if (probeModeValue !== undefined && !(HOSTED_PROBE_MODES as readonly string[]).includes(probeModeValue)) throw new Error(`unsupported hosted probe mode: ${probeModeValue}`);
const expectedProbeMode: HostedProbeMode = (probeModeValue as HostedProbeMode | undefined) ?? "none";
const PROBE_MODE = expectedProbeMode === "inventory-negative";
if (PROBE_MODE && (expectedPackageCase !== "candidate-only" || expectedOwnerProfile === "gentle-pi" || expectedScenario !== "cancel" || RELOAD_MODE)) throw new Error("inventory-negative probe requires candidate-only settings, a negative owner, cancel scenario, and no reload");
const SINGLE_LAYOUT_OPTIONS = [
	{ label: "Compact", description: "Use a compact layout." },
	{ label: "Detailed", description: "Use a detailed layout." },
] as const;
const MULTI_LAYOUT_OPTIONS = [
	...SINGLE_LAYOUT_OPTIONS,
	{ label: "Spacious", description: "Use a spacious layout." },
] as const;
const SPACING_OPTIONS = [
	{ label: "Dense", description: "Use tighter spacing." },
	{ label: "Relaxed", description: "Use more generous spacing." },
] as const;
const SINGLE_LAYOUT_QUESTION = { question: QUESTION, header: "Layout", options: SINGLE_LAYOUT_OPTIONS } as const;
const MULTI_LAYOUT_QUESTION = { question: QUESTION, header: "Layout", options: MULTI_LAYOUT_OPTIONS, multiSelect: true } as const;
const SPACING_QUESTION = { question: SECOND_QUESTION, header: "Spacing", options: SPACING_OPTIONS, multiSelect: false } as const;
const SCHEMA_POSITIVE_QUESTION = {
	question: THIRD_QUESTION, header: "Compare", multiSelect: true, options: [
		{ label: "Compact", description: "Compare the compact option.", preview: "## Compact" },
		{ label: "Detailed", description: "Compare the detailed option." },
	],
} as const;
const QUESTION_ARGUMENTS_BY_SCENARIO = {
	cancel: { questions: [SINGLE_LAYOUT_QUESTION] },
	single: { questions: [SINGLE_LAYOUT_QUESTION] },
	custom: { questions: [SINGLE_LAYOUT_QUESTION] },
	multi: { questions: [MULTI_LAYOUT_QUESTION] },
	"empty-multi": { questions: [MULTI_LAYOUT_QUESTION] },
	"partial-cancel": { questions: [SINGLE_LAYOUT_QUESTION, SPACING_QUESTION] },
	"schema-positive": { questions: [SINGLE_LAYOUT_QUESTION, SPACING_QUESTION, SCHEMA_POSITIVE_QUESTION] },
	"invalid-missing-questions": {},
	"invalid-empty-questions": { questions: [] },
	"invalid-one-option": { questions: [{ question: QUESTION, header: "Layout", options: [{ label: "Compact", description: "Use a compact layout." }] }] },
} as const;
const QUESTION_ARGUMENTS = QUESTION_ARGUMENTS_BY_SCENARIO[expectedScenario];
type PromptProjection = { questions: { question: string; header: string; multiSelect: boolean; options: { label: string; description: string; hasPreview: boolean }[] }[] };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
type HostedPackageEntry = { source: string; extensions: string[]; skills: string[]; prompts: string[]; themes: string[] };
type HostedPackageProfile = { packages: HostedPackageEntry[]; root: { extensions: string[]; skills: string[]; prompts: string[]; themes: string[] } };
function readStringArray(value: unknown, label: string): string[] {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) throw new Error(`${label} must be a string array`);
	return [...value];
}
function readPackageEntry(value: unknown, index: number): HostedPackageEntry {
	if (!isRecord(value) || typeof value.source !== "string") throw new Error(`package entry ${index} is invalid`);
	if (Object.keys(value).sort().join(",") !== "extensions,prompts,skills,source,themes") throw new Error(`package entry ${index} shape changed`);
	return {
		source: value.source,
		extensions: readStringArray(value.extensions, `package entry ${index}.extensions`),
		skills: readStringArray(value.skills, `package entry ${index}.skills`),
		prompts: readStringArray(value.prompts, `package entry ${index}.prompts`),
		themes: readStringArray(value.themes, `package entry ${index}.themes`),
	};
}
function readPackageProfile(): HostedPackageProfile {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (typeof agentDir !== "string" || agentDir.length === 0) throw new Error("package mode requires PI_CODING_AGENT_DIR");
	const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as unknown;
	if (!isRecord(settings) || Object.keys(settings).sort().join(",") !== "extensions,packages,prompts,skills,themes") throw new Error("package settings shape changed");
	if (!Array.isArray(settings.packages)) throw new Error("package settings packages must be an array");
	return {
		packages: settings.packages.map((entry, index) => readPackageEntry(entry, index)),
		root: {
			extensions: readStringArray(settings.extensions, "root.extensions"),
			skills: readStringArray(settings.skills, "root.skills"),
			prompts: readStringArray(settings.prompts, "root.prompts"),
			themes: readStringArray(settings.themes, "root.themes"),
		},
	};
}
function readProbeOwnerState(): Record<string, unknown> {
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	if (typeof agentDir !== "string" || agentDir.length === 0) throw new Error("owner probe requires PI_CODING_AGENT_DIR");
	const ownerPath = join(agentDir, "gentle-ai", "question-owner.json");
	try {
		return { state: "present", content: readFileSync(ownerPath, "utf8") };
	} catch (error) {
		if (!isRecord(error) || error.code !== "ENOENT") throw error;
		return { state: "missing" };
	}
}

function expectedAnswer(scenario: AnsweredScenario): Record<string, unknown> {
	if (scenario === "single") return { questionIndex: 0, question: QUESTION, kind: "option", answer: "Compact" };
	if (scenario === "custom") return { questionIndex: 0, question: QUESTION, kind: "custom", answer: CUSTOM_ANSWER };
	return { questionIndex: 0, question: QUESTION, kind: "multi", answer: null, selected: scenario === "multi" ? ["Compact", "Detailed"] : [] };
}
function expectedAnswers(scenario: HostedScenario): Record<string, unknown>[] {
	if (scenario === "cancel" || scenario === "schema-positive" || isInvalidScenario(scenario)) return [];
	if (scenario === "partial-cancel") return [expectedAnswer("single")];
	return [expectedAnswer(scenario)];
}
function textContent(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.content) || value.content.length !== 1) return undefined;
	const block = value.content[0];
	return isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}
function expectedContent(scenario: HostedScenario): string {
	if (scenario === "cancel" || scenario === "partial-cancel" || scenario === "schema-positive" || isInvalidScenario(scenario)) return DECLINE_MESSAGE;
	const answer = expectedAnswer(scenario);
	const scalar = answer.kind === "multi"
		? Array.isArray(answer.selected) && answer.selected.length > 0 ? answer.selected.join(", ") : "(no input)"
		: typeof answer.answer === "string" ? answer.answer : "(no input)";
	return `User has answered your questions: "${QUESTION}"="${scalar}". You can now continue with the user's answers in mind.`;
}
function answerMatches(value: unknown, expected: Record<string, unknown>, allowUndefinedPreview: boolean): boolean {
	if (!isRecord(value)) return false;
	const keys = Object.keys(value).filter((key) => key !== "preview" || !allowUndefinedPreview || value.preview !== undefined);
	return keys.length === Object.keys(expected).length
		&& Object.entries(expected).every(([key, field]) => {
			const actual = value[key];
			return Array.isArray(field)
				? Array.isArray(actual) && actual.length === field.length && field.every((item, index) => actual[index] === item)
				: actual === field;
		});
}
function expectedResult(value: unknown, scenario: HostedScenario): boolean {
	if (!isRecord(value) || !isRecord(value.details) || Object.keys(value.details).sort().join(",") !== "answers,cancelled" || !Array.isArray(value.details.answers)) return false;
	const expected = expectedAnswers(scenario);
	if (value.details.cancelled !== (scenario === "cancel" || scenario === "partial-cancel" || scenario === "schema-positive") || value.details.answers.length !== expected.length) return false;
	// Only single-select answer paths allow the reference's internal preview: undefined; JSON transport omits it.
	const allowUndefinedPreview = scenario === "single" || scenario === "partial-cancel";
	return value.details.answers.every((answer, index) => answerMatches(answer, expected[index]!, allowUndefinedPreview))
		&& textContent(value) === expectedContent(scenario);
}
function successfulResult(value: unknown, scenario: HostedScenario): boolean { return expectedResult(value, scenario); }
function projectQuestionArguments(value: { questions: readonly { question: string; header: string; multiSelect?: boolean; options: readonly { label: string; description: string; preview?: string }[] }[] }): PromptProjection {
	return {
		questions: value.questions.map((question) => ({
			question: question.question,
			header: question.header,
			multiSelect: question.multiSelect ?? false,
			options: question.options.map((option) => ({ label: option.label, description: option.description, hasPreview: Boolean(option.preview) })),
		})),
	};
}
function projectPrompt(value: unknown): PromptProjection | undefined {
	if (!isRecord(value) || !Array.isArray(value.questions)) return undefined;
	const questions: PromptProjection["questions"] = [];
	for (const rawQuestion of value.questions) {
		if (!isRecord(rawQuestion) || typeof rawQuestion.question !== "string" || typeof rawQuestion.header !== "string" || typeof rawQuestion.multiSelect !== "boolean" || !Array.isArray(rawQuestion.options)) return undefined;
		const options: PromptProjection["questions"][number]["options"] = [];
		for (const rawOption of rawQuestion.options as unknown[]) {
			if (!isRecord(rawOption) || typeof rawOption.label !== "string" || typeof rawOption.description !== "string" || typeof rawOption.hasPreview !== "boolean") return undefined;
			options.push({ label: rawOption.label, description: rawOption.description, hasPreview: rawOption.hasPreview });
		}
		questions.push({ question: rawQuestion.question, header: rawQuestion.header, multiSelect: rawQuestion.multiSelect, options });
	}
	return { questions };
}
function mark(state: FixtureState, message: string): void { state.notify?.(message); }
function trace(state: FixtureState, event: string, details: Record<string, unknown> = {}): void {
	if (!RELOAD_MODE) return;
	mark(state, `${RELOAD_TELEMETRY_PREFIX}${JSON.stringify({ pid: process.pid, generation: state.generation, event, ...details })}`);
}
function notifyToolSchema(pi: ExtensionAPI, state: FixtureState): void {
	const tool = pi.getAllTools().find((candidate) => candidate.name === TOOL_NAME);
	if (!tool) return mark(state, `${MARKERS.schema}error:tool-not-found`);
	let encoded: string | undefined;
	try { encoded = JSON.stringify(tool.parameters); } catch { return mark(state, `${MARKERS.schema}error:not-json-serializable`); }
	if (encoded === undefined) return mark(state, `${MARKERS.schema}error:not-json-serializable`);
	if (encoded.length > SCHEMA_NOTIFICATION_MAX) return mark(state, `${MARKERS.schema}error:too-large`);
	mark(state, `${MARKERS.schema}${encoded}`);
}
function notifyPackageComposition(pi: ExtensionAPI, state: FixtureState): void {
	if (expectedPackageCase === undefined) return;
	const describedTools = pi.getAllTools().map((tool) => {
		const sourceInfo: unknown = tool.sourceInfo; if (!isRecord(sourceInfo) || typeof sourceInfo.path !== "string" || typeof sourceInfo.source !== "string") throw new Error(`tool ${tool.name} provenance changed`);
		return { tool, sourceInfo: { path: sourceInfo.path, source: sourceInfo.source } };
	});
	const questionnaireTools = describedTools.filter(({ tool }) => tool.name === TOOL_NAME);
	const builtinTools = describedTools.filter(({ sourceInfo }) => sourceInfo.source === "builtin"); const sdkTools = describedTools.filter(({ sourceInfo }) => sourceInfo.source === "sdk"); const otherTools = describedTools.filter(({ sourceInfo }) => sourceInfo.source !== "builtin" && sourceInfo.source !== "sdk");
	const payload = {
		packageCase: expectedPackageCase,
		profile: readPackageProfile(),
		inventory: {
			allToolNames: describedTools.map(({ tool }) => tool.name), activeToolNames: pi.getActiveTools(),
			builtinToolNames: builtinTools.map(({ tool }) => tool.name), sdkToolNames: sdkTools.map(({ tool }) => tool.name),
			otherTools: otherTools.map(({ tool, sourceInfo }) => ({ name: tool.name, sourceInfo })),
			questionnaireCount: questionnaireTools.length, questionnaire: questionnaireTools.map(({ tool, sourceInfo }) => ({ name: tool.name, sourceInfoPath: sourceInfo.path })),
		},
	};
	const encoded = JSON.stringify(payload);
	if (encoded.length > 8_000) throw new Error("package composition telemetry exceeded its bound");
	mark(state, `${PACKAGE_COMPOSITION_PREFIX}${encoded}`);
}
function isPublicValidationText(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && !/SyntaxError|ReferenceError|TypeError|Cannot find module|ERR_MODULE_NOT_FOUND|jiti|loader|compile|transpil|stack trace/i.test(value);
}
function cancelledDetails(value: unknown): boolean { return isRecord(value) && value.cancelled === true && Array.isArray(value.answers) && value.answers.length === 0; }
function partialCancelledDetails(value: unknown): boolean {
	return isRecord(value) && value.cancelled === true && Object.keys(value).sort().join(",") === "answers,cancelled"
		&& Array.isArray(value.answers) && value.answers.length === 1 && answerMatches(value.answers[0], expectedAnswer("single"), true);
}
function latestQuestionnaireResult(context: Context, toolCallId: string): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "toolResult" && message.toolName === TOOL_NAME && message.toolCallId === toolCallId) return message;
	}
	return undefined;
}
function createMessage(model: Model<any>): AssistantMessage {
	return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id, usage: { ...ZERO_USAGE, cost: { ...ZERO_USAGE.cost } }, stopReason: "pending", timestamp: Date.now() };
}
function emitError(stream: AssistantMessageEventStream, output: AssistantMessage, options: SimpleStreamOptions | undefined, message: string): void {
	const reason: "aborted" | "error" = options?.signal?.aborted ? "aborted" : "error";
	output.stopReason = reason;
	output.errorMessage = message;
	stream.push({ type: "error", reason, error: output });
	stream.end();
}
function notifyProviderContextInventory(context: Context, state: FixtureState): void {
	if (expectedPackageCase === undefined) return;
	if (!Array.isArray(context.tools)) throw new Error("package provider context omitted tools");
	const toolNames = context.tools.map((tool, index) => { if (!isRecord(tool) || typeof tool.name !== "string") throw new Error(`package provider context tool ${index} is invalid`); return tool.name; });
	const encoded = JSON.stringify({ toolCallId: state.toolCallId, toolNames }); if (encoded.length > 4_000) throw new Error("package provider context telemetry exceeded its bound");
	mark(state, `${PACKAGE_PROVIDER_INVENTORY_PREFIX}${encoded}`);
}
let providerStreamCalls = 0;
function streamSynthetic(model: Model<any>, context: Context, options: SimpleStreamOptions | undefined, state: FixtureState): AssistantMessageEventStream {
	providerStreamCalls += 1;
	if (PROBE_MODE) mark(state, `${PROVIDER_ENTRY_PREFIX}${JSON.stringify({ count: providerStreamCalls })}`);
	const stream = createAssistantMessageEventStream();
	const output = createMessage(model);
	stream.push({ type: "start", partial: output });
	trace(state, "provider_request", { toolCallId: state.toolCallId });
	try {
		notifyProviderContextInventory(context, state);
		if (options?.signal?.aborted) {
			emitError(stream, output, options, "Synthetic questionnaire request was aborted");
			trace(state, "provider_completion", { stopReason: output.stopReason, toolCallId: state.toolCallId });
			return stream;
		}
		const result = latestQuestionnaireResult(context, state.toolCallId);
		if (!state.questionIssued && !result) {
			state.questionIssued = true;
			const toolCall: ToolCall = { type: "toolCall", id: state.toolCallId, name: TOOL_NAME, arguments: {} };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			toolCall.arguments = QUESTION_ARGUMENTS;
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(QUESTION_ARGUMENTS), partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: { ...toolCall }, partial: output });
			output.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const invalidScenario = isInvalidScenario(expectedScenario);
			const observedErrorText = textContent(result);
			const expectedResultObserved = invalidScenario
				? result?.isError === true && isPublicValidationText(observedErrorText) && state.observed.validationError === observedErrorText
				: expectedScenario === "cancel" || expectedScenario === "schema-positive"
					? state.observed.cancelled && cancelledDetails(result?.details) && textContent(result) === DECLINE_MESSAGE
					: expectedScenario === "partial-cancel"
						? state.observed.cancelled && partialCancelledDetails(result?.details) && textContent(result) === DECLINE_MESSAGE
						: state.observed.completed && successfulResult(result, expectedScenario);
			const observerContract = invalidScenario
				? !state.observed.toolCall && state.observed.prompt === 0 && state.observed.promptProjection === undefined && state.observed.blocked.length === 0 && !state.observed.cancelled && !state.observed.completed
				: state.observed.toolCall && state.observed.prompt === 1 && state.observed.promptProjection !== undefined && state.observed.blocked.join(",") === "true,false";
			if (!state.observed.session || !state.observed.beforeAgent || !state.observed.registered || !state.observed.invoked || !observerContract || !expectedResultObserved || (invalidScenario ? result?.isError !== true : result?.isError === true)) throw new Error("hosted questionnaire observer contract was incomplete");
			const finalText = FINAL_TEXT[expectedScenario];
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial: output }); const block = output.content[0]; if (block?.type !== "text") throw new Error("synthetic text block was not created"); block.text = finalText;
			stream.push({ type: "text_delta", contentIndex: 0, delta: finalText, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: output });
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
		}
	} catch (error) {
		emitError(stream, output, options, error instanceof Error ? error.message : String(error));
		trace(state, "provider_completion", { stopReason: output.stopReason, toolCallId: state.toolCallId });
		return stream;
	}
	trace(state, "provider_completion", { stopReason: output.stopReason, toolCallId: state.toolCallId });
	stream.end();
	return stream;
}

export default function (pi: ExtensionAPI): void {
	const generation = nextGeneration();
	const state = createState(generation);
	const emit = (message: string): void => mark(state, message);
	pi.registerProvider(PROVIDER_ID, {
		name: "Hosted questionnaire synthetic", baseUrl: "synthetic://hosted-questionnaire", apiKey: "synthetic-no-network-key", api: API_ID, authHeader: false,
		models: [{ id: MODEL_ID, name: "Hosted questionnaire synthetic", reasoning: false, input: ["text"], cost: ZERO_USAGE.cost, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple: (model, context, options) => streamSynthetic(model, context, options, state),
	});
	if (PROBE_MODE) pi.registerCommand(PROBE_COMMAND, { handler: async (_args, ctx) => {
		const describedTools = pi.getAllTools().map((tool) => {
			const sourceInfo: unknown = tool.sourceInfo;
			if (!isRecord(sourceInfo) || typeof sourceInfo.path !== "string" || typeof sourceInfo.source !== "string") throw new Error(`tool ${tool.name} provenance changed`);
			return { name: tool.name, sourceInfo: { path: sourceInfo.path, source: sourceInfo.source } };
		});
		const questionnaire = describedTools.filter((tool) => tool.name === TOOL_NAME);
		const payload = {
			mode: ctx.mode, hasUI: ctx.hasUI, catalog: describedTools, activeToolNames: pi.getActiveTools(),
			questionnaireCount: questionnaire.length, questionnaire, ownerState: readProbeOwnerState(),
			settingsProfile: readPackageProfile(), fixturePath: fileURLToPath(import.meta.url), providerStreamCalls,
		};
		const encoded = JSON.stringify(payload);
		if (encoded.length > PROBE_INVENTORY_MAX) throw new Error("negative owner probe inventory exceeded its bound");
		ctx.ui.notify(`${PROBE_INVENTORY_PREFIX}${encoded}`, "info");
		return;
	} });
	if (RELOAD_MODE) pi.registerCommand("hosted-questionnaire-reload-v1", { handler: async (_args, ctx) => { await ctx.reload(); return; } });
	pi.on("session_start", (event, ctx) => {
		state.observed.session = true;
		state.notify = (message) => ctx.ui.notify(message, "info");
		emit(MARKERS.session);
		trace(state, "session_start", { reason: event.reason });
	});
	pi.on("session_shutdown", (event) => { trace(state, "session_shutdown", { reason: event.reason }); });
	pi.on("resources_discover", (event) => { trace(state, "resources_discover", { reason: event.reason }); });
	pi.on("before_agent_start", (_event, ctx) => {
		state.observed.beforeAgent = true;
		const questionnaireTools = pi.getAllTools().filter((tool) => tool.name === TOOL_NAME);
		state.observed.registered = questionnaireTools[0]?.sourceInfo.path === expectedSourcePath;
		trace(state, "tool_inventory", { sourceInfo: questionnaireTools[0]?.sourceInfo.path ?? null, count: questionnaireTools.length, mode: ctx.mode, hasUI: ctx.hasUI });
		emit(MARKERS.beforeAgent);
		if (state.observed.registered) emit(MARKERS.registered);
		if (!PROBE_MODE) {
			notifyToolSchema(pi, state);
			notifyPackageComposition(pi, state);
		}
	});
	pi.on("tool_execution_start", (event) => { if (event.toolName === TOOL_NAME) { state.observed.invoked = true; trace(state, "tool_callback", { phase: "execution_start", toolCallId: event.toolCallId }); emit(MARKERS.invoked); } });
	pi.on("tool_call", (event) => { if (event.toolName === TOOL_NAME) { state.observed.toolCall = true; trace(state, "tool_callback", { phase: "call", toolCallId: event.toolCallId }); emit(MARKERS.toolCall); } });
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== TOOL_NAME) return;
		trace(state, "tool_callback", { phase: "execution_end", toolCallId: event.toolCallId, isError: event.isError });
		if (event.isError) {
			const errorText = textContent(event.result);
			if (isInvalidScenario(expectedScenario) && isPublicValidationText(errorText)) { state.observed.validationError = errorText; emit(MARKERS.validationError); }
			return;
		}
		if (!isRecord(event.result)) return;
		if (expectedScenario === "cancel" || expectedScenario === "schema-positive") {
			if (!expectedResult(event.result, expectedScenario) || !cancelledDetails(event.result.details)) return;
			state.observed.cancelled = true;
			emit(MARKERS.cancelled);
			return;
		}
		if (expectedScenario === "partial-cancel") {
			if (!expectedResult(event.result, expectedScenario) || !partialCancelledDetails(event.result.details)) return;
			state.observed.cancelled = true;
			emit(MARKERS.cancelled);
			return;
		}
		if (isInvalidScenario(expectedScenario)) return;
		if (!successfulResult(event.result, expectedScenario)) {
			const details = isRecord(event.result) ? event.result.details : undefined;
			const answers = isRecord(details) ? details.answers : undefined;
			const answer = Array.isArray(answers) ? answers[0] : undefined;
			const hasOwnPreview = isRecord(answer) && Object.prototype.hasOwnProperty.call(answer, "preview");
			const renderedText = textContent(event.result);
			emit(`hosted:questionnaire-result-rejected:${JSON.stringify({
				scenario: expectedScenario,
				answerKeys: isRecord(answer) ? Object.keys(answer) : [],
				hasOwnPreview,
				previewType: isRecord(answer) ? typeof answer.preview : "undefined",
				textContent: renderedText === undefined ? null : renderedText.slice(0, 500),
			})}`);
			return;
		}
		state.observed.completed = true;
		emit(MARKERS.completed);
	});
	pi.events.on(PROMPT_EVENT, (data) => {
		trace(state, "prompt", { count: state.observed.prompt + 1 });
		if (!("questions" in QUESTION_ARGUMENTS)) throw new Error("invalid questionnaire scenario emitted a prompt without questions");
		const projection = projectPrompt(data);
		if (projection === undefined || JSON.stringify(projection) !== JSON.stringify(projectQuestionArguments(QUESTION_ARGUMENTS))) return;
		state.observed.prompt += 1;
		const encoded = JSON.stringify(projection);
		state.observed.promptProjection = encoded;
		emit(MARKERS.prompt);
		emit(`${MARKERS.prompt}:projection:${encoded}`);
	});
	pi.events.on(BLOCKED_EVENT, (data) => { if (isRecord(data) && typeof data.active === "boolean") { state.observed.blocked.push(data.active); trace(state, "blocked", { active: data.active }); emit(MARKERS.blocked(data.active)); } });
}
