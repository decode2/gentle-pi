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
const FINAL_TEXT = "Synthetic provider completed after questionnaire cancellation.";
const MARKERS = { session: "hosted:session_start", beforeAgent: "hosted:before_agent_start", registered: "hosted:ask_user_question:registered", invoked: "hosted:ask_user_question:invoked", cancelled: "hosted:ask_user_question:cancelled", prompt: "hosted:rpiv:ask-user:prompt", blocked: (active: boolean) => `hosted:rpiv:ask-user:blocked:${active}` } as const;
const OWNED_SOURCE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../extensions/ask-user-question.ts");
const REFERENCE_SOURCE_PATH = "/reference/node_modules/@juicesharp/rpiv-ask-user-question/index.ts";
const expectedSourcePath = process.env.GENTLE_PI_HOSTED_EXPECTED_SOURCE_PATH ?? OWNED_SOURCE_PATH;
if (expectedSourcePath !== OWNED_SOURCE_PATH && expectedSourcePath !== REFERENCE_SOURCE_PATH) throw new Error(`unsupported hosted questionnaire source path: ${expectedSourcePath}`);
const QUESTION_ARGUMENTS = { questions: [{ question: "Which layout should we inspect?", header: "Layout", options: [{ label: "Compact", description: "Use a compact layout." }, { label: "Detailed", description: "Use a detailed layout." }] }] };
type PromptProjection = { questions: { question: string; header: string; multiSelect: boolean; options: { label: string; description: string; hasPreview: boolean }[] }[] };
const observed = { session: false, beforeAgent: false, registered: false, invoked: false, cancelled: false, prompt: 0, promptProjection: undefined as string | undefined, blocked: [] as boolean[] };
const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
let notify: ((message: string) => void) | undefined;
let questionIssued = false;

function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
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
			if (!observed.session || !observed.beforeAgent || !observed.registered || !observed.invoked || observed.prompt !== 1 || observed.promptProjection === undefined || observed.blocked.join(",") !== "true,false" || !observed.cancelled || result?.isError || !cancelledDetails(result?.details)) throw new Error("hosted questionnaire observer contract was incomplete");
			output.content.push({ type: "text", text: "" });
			stream.push({ type: "text_start", contentIndex: 0, partial: output }); const block = output.content[0]; if (block?.type !== "text") throw new Error("synthetic text block was not created"); block.text = FINAL_TEXT;
			stream.push({ type: "text_delta", contentIndex: 0, delta: FINAL_TEXT, partial: output });
			stream.push({ type: "text_end", contentIndex: 0, content: FINAL_TEXT, partial: output });
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
		if (event.toolName !== TOOL_NAME || event.isError || !isRecord(event.result) || !cancelledDetails(event.result.details)) return;
		observed.cancelled = true;
		mark(MARKERS.cancelled);
	});
	pi.events.on(PROMPT_EVENT, (data) => {
		const projection = projectPrompt(data);
		if (projection === undefined) return;
		observed.prompt += 1;
		const encoded = JSON.stringify(projection);
		observed.promptProjection = encoded;
		mark(MARKERS.prompt);
		mark(`${MARKERS.prompt}:projection:${encoded}`);
	});
	pi.events.on(BLOCKED_EVENT, (data) => { if (isRecord(data) && typeof data.active === "boolean") { observed.blocked.push(data.active); mark(MARKERS.blocked(data.active)); } });
}
