import { dirname, resolve } from "node:path";
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
const CUSTOM_ANSWER = "  leading  internal\ntrailing  ";
const DECLINE_MESSAGE = "User declined to answer questions";
const FINAL_TEXT = {
	cancel: "Synthetic provider completed after questionnaire cancellation.",
	single: "Synthetic provider completed after questionnaire single selection.",
	custom: "Synthetic provider completed after questionnaire custom response.",
	multi: "Synthetic provider completed after questionnaire multi selection.",
	"empty-multi": "Synthetic provider completed after questionnaire empty multi selection.",
	"partial-cancel": "Synthetic provider completed after questionnaire partial cancellation.",
} as const;
const MARKERS = { session: "hosted:session_start", beforeAgent: "hosted:before_agent_start", registered: "hosted:ask_user_question:registered", invoked: "hosted:ask_user_question:invoked", cancelled: "hosted:ask_user_question:cancelled", completed: "hosted:ask_user_question:completed", prompt: "hosted:rpiv:ask-user:prompt", blocked: (active: boolean) => `hosted:rpiv:ask-user:blocked:${active}` } as const;
const HOSTED_SCENARIOS = ["cancel", "single", "custom", "multi", "empty-multi", "partial-cancel"] as const;
type HostedScenario = (typeof HOSTED_SCENARIOS)[number];
type AnsweredScenario = Exclude<HostedScenario, "cancel" | "partial-cancel">;
const OWNED_SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../extensions/ask-user-question.ts");
const REFERENCE_SOURCE_PATH = "/reference/node_modules/@juicesharp/rpiv-ask-user-question/index.ts";
const expectedSourcePath = process.env.GENTLE_PI_HOSTED_EXPECTED_SOURCE_PATH ?? OWNED_SOURCE_PATH;
if (expectedSourcePath !== OWNED_SOURCE_PATH && expectedSourcePath !== REFERENCE_SOURCE_PATH) throw new Error(`unsupported hosted questionnaire source path: ${expectedSourcePath}`);
const scenarioValue = process.env.GENTLE_PI_HOSTED_SCENARIO;
if (scenarioValue !== undefined && !(HOSTED_SCENARIOS as readonly string[]).includes(scenarioValue)) throw new Error(`unsupported hosted questionnaire scenario: ${scenarioValue}`);
const expectedScenario: HostedScenario = (scenarioValue as HostedScenario | undefined) ?? "cancel";
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
const QUESTION_ARGUMENTS_BY_SCENARIO = {
	cancel: { questions: [SINGLE_LAYOUT_QUESTION] },
	single: { questions: [SINGLE_LAYOUT_QUESTION] },
	custom: { questions: [SINGLE_LAYOUT_QUESTION] },
	multi: { questions: [MULTI_LAYOUT_QUESTION] },
	"empty-multi": { questions: [MULTI_LAYOUT_QUESTION] },
	"partial-cancel": { questions: [SINGLE_LAYOUT_QUESTION, SPACING_QUESTION] },
} as const;
const QUESTION_ARGUMENTS = QUESTION_ARGUMENTS_BY_SCENARIO[expectedScenario];
type PromptProjection = { questions: { question: string; header: string; multiSelect: boolean; options: { label: string; description: string; hasPreview: boolean }[] }[] };
const observed = { session: false, beforeAgent: false, registered: false, invoked: false, cancelled: false, completed: false, prompt: 0, promptProjection: undefined as string | undefined, blocked: [] as boolean[] };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let notify: ((message: string) => void) | undefined;
let questionIssued = false;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function expectedAnswer(scenario: AnsweredScenario): Record<string, unknown> {
	if (scenario === "single") return { questionIndex: 0, question: QUESTION, kind: "option", answer: "Compact" };
	if (scenario === "custom") return { questionIndex: 0, question: QUESTION, kind: "custom", answer: CUSTOM_ANSWER };
	return { questionIndex: 0, question: QUESTION, kind: "multi", answer: null, selected: scenario === "multi" ? ["Compact", "Detailed"] : [] };
}
function expectedAnswers(scenario: HostedScenario): Record<string, unknown>[] {
	if (scenario === "cancel") return [];
	if (scenario === "partial-cancel") return [expectedAnswer("single")];
	return [expectedAnswer(scenario)];
}
function textContent(value: unknown): string | undefined {
	if (!isRecord(value) || !Array.isArray(value.content) || value.content.length !== 1) return undefined;
	const block = value.content[0];
	return isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : undefined;
}
function expectedContent(scenario: HostedScenario): string {
	if (scenario === "cancel" || scenario === "partial-cancel") return DECLINE_MESSAGE;
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
	if (value.details.cancelled !== (scenario === "cancel" || scenario === "partial-cancel") || value.details.answers.length !== expected.length) return false;
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
function mark(message: string): void { notify?.(message); }
function cancelledDetails(value: unknown): boolean { return isRecord(value) && value.cancelled === true && Array.isArray(value.answers) && value.answers.length === 0; }
function partialCancelledDetails(value: unknown): boolean {
	return isRecord(value) && value.cancelled === true && Object.keys(value).sort().join(",") === "answers,cancelled"
		&& Array.isArray(value.answers) && value.answers.length === 1 && answerMatches(value.answers[0], expectedAnswer("single"), true);
}
function latestQuestionnaireResult(context: Context): ToolResultMessage | undefined {
	for (let index = context.messages.length - 1; index >= 0; index -= 1) {
		const message = context.messages[index];
		if (message?.role === "toolResult" && message.toolName === TOOL_NAME) return message;
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
function streamSynthetic(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	const output = createMessage(model);
	stream.push({ type: "start", partial: output });
	try {
		if (options?.signal?.aborted) return emitError(stream, output, options, "Synthetic questionnaire request was aborted"), stream;
		const result = latestQuestionnaireResult(context);
		if (!questionIssued && !result) {
			questionIssued = true;
			const toolCall: ToolCall = { type: "toolCall", id: TOOL_CALL_ID, name: TOOL_NAME, arguments: {} };
			output.content.push(toolCall);
			stream.push({ type: "toolcall_start", contentIndex: 0, partial: output });
			toolCall.arguments = QUESTION_ARGUMENTS;
			stream.push({ type: "toolcall_delta", contentIndex: 0, delta: JSON.stringify(QUESTION_ARGUMENTS), partial: output });
			stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: { ...toolCall }, partial: output });
			output.stopReason = "toolUse";
			stream.push({ type: "done", reason: "toolUse", message: output });
		} else {
			const expectedResultObserved = expectedScenario === "cancel"
				? observed.cancelled && cancelledDetails(result?.details) && textContent(result) === DECLINE_MESSAGE
				: expectedScenario === "partial-cancel"
					? observed.cancelled && partialCancelledDetails(result?.details) && textContent(result) === DECLINE_MESSAGE
					: observed.completed && successfulResult(result, expectedScenario);
			if (!observed.session || !observed.beforeAgent || !observed.registered || !observed.invoked || observed.prompt !== 1 || observed.promptProjection === undefined || observed.blocked.join(",") !== "true,false" || !expectedResultObserved || result?.isError) throw new Error("hosted questionnaire observer contract was incomplete");
			const finalText = FINAL_TEXT[expectedScenario];
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial: output }); const block = output.content[0]; if (block?.type !== "text") throw new Error("synthetic text block was not created"); block.text = finalText;
			stream.push({ type: "text_delta", contentIndex: 0, delta: finalText, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: finalText, partial: output });
			output.stopReason = "stop";
			stream.push({ type: "done", reason: "stop", message: output });
		}
	} catch (error) { emitError(stream, output, options, error instanceof Error ? error.message : String(error)); return stream; }
	stream.end();
	return stream;
}

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, {
		name: "Hosted questionnaire synthetic", baseUrl: "synthetic://hosted-questionnaire", apiKey: "synthetic-no-network-key", api: API_ID, authHeader: false,
		models: [{ id: MODEL_ID, name: "Hosted questionnaire synthetic", reasoning: false, input: ["text"], cost: ZERO_USAGE.cost, contextWindow: 128000, maxTokens: 4096 }],
		streamSimple: streamSynthetic,
	});
	pi.on("session_start", (_event, ctx) => { observed.session = true; notify = (message) => ctx.ui.notify(message, "info"); mark(MARKERS.session); });
	pi.on("before_agent_start", () => {
		observed.beforeAgent = true;
		observed.registered = pi.getAllTools().find((tool) => tool.name === TOOL_NAME)?.sourceInfo.path === expectedSourcePath;
		mark(MARKERS.beforeAgent);
		if (observed.registered) mark(MARKERS.registered);
	});
	pi.on("tool_execution_start", (event) => { if (event.toolName === TOOL_NAME) { observed.invoked = true; mark(MARKERS.invoked); } });
	pi.on("tool_execution_end", (event) => {
		if (event.toolName !== TOOL_NAME || event.isError || !isRecord(event.result)) return;
		if (expectedScenario === "cancel") {
			if (!expectedResult(event.result, expectedScenario) || !cancelledDetails(event.result.details)) return;
			observed.cancelled = true;
			mark(MARKERS.cancelled);
			return;
		}
		if (expectedScenario === "partial-cancel") {
			if (!expectedResult(event.result, expectedScenario) || !partialCancelledDetails(event.result.details)) return;
			observed.cancelled = true;
			mark(MARKERS.cancelled);
			return;
		}
		if (!successfulResult(event.result, expectedScenario)) {
			const details = isRecord(event.result) ? event.result.details : undefined;
			const answers = isRecord(details) ? details.answers : undefined;
			const answer = Array.isArray(answers) ? answers[0] : undefined;
			const hasOwnPreview = isRecord(answer) && Object.prototype.hasOwnProperty.call(answer, "preview");
			const renderedText = textContent(event.result);
			mark(`hosted:questionnaire-result-rejected:${JSON.stringify({
				scenario: expectedScenario,
				answerKeys: isRecord(answer) ? Object.keys(answer) : [],
				hasOwnPreview,
				previewType: isRecord(answer) ? typeof answer.preview : "undefined",
				textContent: renderedText === undefined ? null : renderedText.slice(0, 500),
			})}`);
			return;
		}
		observed.completed = true;
		mark(MARKERS.completed);
	});
	pi.events.on(PROMPT_EVENT, (data) => {
		const projection = projectPrompt(data);
		if (projection === undefined || JSON.stringify(projection) !== JSON.stringify(projectQuestionArguments(QUESTION_ARGUMENTS))) return;
		observed.prompt += 1;
		const encoded = JSON.stringify(projection);
		observed.promptProjection = encoded;
		mark(MARKERS.prompt);
		mark(`${MARKERS.prompt}:projection:${encoded}`);
	});
	pi.events.on(BLOCKED_EVENT, (data) => { if (isRecord(data) && typeof data.active === "boolean") { observed.blocked.push(data.active); mark(MARKERS.blocked(data.active)); } });
}
