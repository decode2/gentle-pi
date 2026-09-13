import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { FrozenQuestion, FrozenQuestionnaireRequest, QuestionPresentationDriver } from "./contract.ts";
import type { QuestionnaireLocalizer } from "./localization.ts";
import {
	createQuestionnairePresentationState,
	reduceQuestionnairePresentation,
	toRawQuestionnaireOutcome,
	type QuestionnairePresentationState,
} from "./presentation-state.ts";

type RpcAction = "choose-option" | "choose-options" | "custom" | "back" | "skip" | "next" | "submit" | "submit-partial" | "cancel";

const ABORTED = Symbol("rpc-presentation-aborted");
type AbortResult = typeof ABORTED;
const english: QuestionnaireLocalizer = (_key, fallback) => fallback;

/** Sequential RPC presentation with cancellation guarded around each native dialog. */
export function createRpcQuestionPresentationDriver(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	localize: QuestionnaireLocalizer = english,
): QuestionPresentationDriver {
	return { async present(request, signal) {
		let state = createQuestionnairePresentationState(request);
		while (!state.cancelled && !state.submitted) {
			const next = await presentQuestion(ui, state, localize, signal);
			if (next === ABORTED || signal?.aborted) return toRawQuestionnaireOutcome(cancel(state));
			state = next;
		}
		return signal?.aborted ? toRawQuestionnaireOutcome(cancel(state)) : toRawQuestionnaireOutcome(state);
	} };
}

async function presentQuestion(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
	localize: QuestionnaireLocalizer,
	signal?: AbortSignal,
): Promise<QuestionnairePresentationState | AbortResult> {
	const index = state.activeQuestionIndex;
	const question = state.request.questions[index]!;
	const actions = actionLabels(state, question, localize);
	if (!actions) return cancel(state);
	const selected = await withAbort(
		() => ui.select(questionTitle(question, index, localize), [...actions.keys()], signal === undefined ? undefined : { signal }), signal,
	);
	if (selected === ABORTED) return ABORTED;
	const action = selected === undefined ? undefined : actions.get(selected);
	if (!action) return cancel(state);
	if (action === "cancel") return cancel(state);
	if (action === "back") return reduceQuestionnairePresentation(state, { type: "focus-question", questionIndex: index - 1 });
	if (action === "skip") return moveTo(state, index + 1);
	if (action === "submit-partial") return reduceQuestionnairePresentation(state, { type: "submit-partial" });
	if (action === "next" || action === "submit") {
		const committed = reduceQuestionnairePresentation(state, { type: "next" });
		return action === "submit" ? reduceQuestionnairePresentation(committed, { type: "submit-partial" }) : moveTo(committed, index + 1);
	}
	if (action === "custom") return editCustom(ui, state, index, localize, signal);
	return chooseOption(ui, state, question, index, localize, signal);
}

function actionLabels(
	state: QuestionnairePresentationState,
	question: FrozenQuestion,
	localize: QuestionnaireLocalizer,
): Map<string, RpcAction> | undefined {
	const index = state.activeQuestionIndex;
	const entries: Array<readonly [string, RpcAction]> = [
		[localize(question.multiSelect ? "rpc.action.choose-options" : "rpc.action.choose-option", question.multiSelect ? "Choose options" : "Choose an option"), question.multiSelect ? "choose-options" : "choose-option"],
		[localize("rpc.action.custom", "Use custom text"), "custom"],
		...(index > 0 ? [[localize("rpc.action.back", "Back"), "back"] as const] : []),
		...(state.committed[index] === undefined ? [[localize("rpc.action.skip", "Skip"), "skip"] as const] : []),
		[index === state.request.questions.length - 1
			? localize("chrome.primary.submit", "Submit")
			: localize("chrome.primary.next", "Next"), index === state.request.questions.length - 1 ? "submit" : "next"],
		[localize("rpc.action.submit-partial", "Submit partial"), "submit-partial"],
		[localize("chrome.cancel", "Cancel"), "cancel"],
	];
	const labels = new Map(entries);
	return labels.size === entries.length ? labels : undefined;
}

async function chooseOption(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
	question: FrozenQuestion,
	index: number,
	localize: QuestionnaireLocalizer,
	signal?: AbortSignal,
): Promise<QuestionnairePresentationState | AbortResult> {
	const options = new Map(question.options.map((option, optionIndex) => [option.label, optionIndex]));
	const selected = await withAbort(
		() => ui.select(questionTitle(question, index, localize), [...options.keys()], signal === undefined ? undefined : { signal }), signal,
	);
	if (selected === ABORTED) return ABORTED;
	const optionIndex = selected === undefined ? undefined : options.get(selected);
	if (optionIndex === undefined) return cancel(state);
	const label = question.options[optionIndex]!.label;
	const next = reduceQuestionnairePresentation(state, { type: "set-tab", questionIndex: index, tab: "options" });
	return question.multiSelect
		? reduceQuestionnairePresentation(next, { type: "toggle-option", questionIndex: index, label })
		: reduceQuestionnairePresentation(next, { type: "select-option", questionIndex: index, label });
}

async function editCustom(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
	index: number,
	localize: QuestionnaireLocalizer,
	signal?: AbortSignal,
): Promise<QuestionnairePresentationState | AbortResult> {
	const value = await withAbort(() => ui.editor(localize("rpc.editor.custom", "Custom response"), state.customDrafts[index]), signal);
	if (value === ABORTED) return ABORTED;
	if (value === undefined) return cancel(state);
	const custom = reduceQuestionnairePresentation(state, { type: "set-custom-draft", questionIndex: index, value });
	return reduceQuestionnairePresentation(custom, { type: "set-tab", questionIndex: index, tab: "custom" });
}

function withAbort<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T | AbortResult> {
	if (!signal) return Promise.resolve().then(operation);
	return new Promise<T | AbortResult>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const settle = (callback: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			callback();
		};
		const onAbort = () => settle(() => resolve(ABORTED));
		if (signal.aborted) {
			onAbort();
			return;
		}
		signal.addEventListener("abort", onAbort, { once: true });
		let pending: Promise<T>;
		try {
			pending = Promise.resolve(operation());
		} catch (error) {
			settle(() => reject(error));
			return;
		}
		pending.then(
			(value) => settle(() => resolve(value)),
			(error) => settle(() => reject(error)),
		);
	});
}

function moveTo(state: QuestionnairePresentationState, index: number): QuestionnairePresentationState {
	return index < state.request.questions.length
		? reduceQuestionnairePresentation(state, { type: "focus-question", questionIndex: index })
		: state;
}

function cancel(state: QuestionnairePresentationState): QuestionnairePresentationState {
	return reduceQuestionnairePresentation(state, { type: "cancel" });
}

function questionTitle(question: FrozenQuestion, index: number, localize: QuestionnaireLocalizer): string {
	const previewCaption = localize("rpc.preview.caption", "Static preview:");
	const options = question.options.map((option) => [
		option.label,
		option.description,
		...(option.preview === undefined ? [] : [`${previewCaption} ${option.preview}`]),
	].join("\n")).join("\n\n");
	const prefix = localize("chrome.question.prefix", "Question {index}:").replaceAll("{index}", String(index + 1));
	const framing = localize("rpc.preview.framing", "Static preview (RPC; full TUI detail unavailable):");
	return `${prefix} ${question.header}\n${question.question}\n\n${framing}\n${options}`;
}
