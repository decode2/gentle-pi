import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { FrozenQuestion, FrozenQuestionnaireRequest, QuestionPresentationDriver } from "./contract.ts";
import {
	createQuestionnairePresentationState,
	reduceQuestionnairePresentation,
	toRawQuestionnaireOutcome,
	type QuestionnairePresentationState,
} from "./presentation-state.ts";

/**
 * Sequential RPC presentation. The public RPC editor has no AbortSignal or
 * timeout capability, so this driver waits for each host result in turn.
 */
export function createRpcQuestionPresentationDriver(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
): QuestionPresentationDriver {
	return { async present(request) {
		let state = createQuestionnairePresentationState(request);
		try {
			while (!state.cancelled && !state.submitted) state = await presentQuestion(ui, state);
		} catch {
			state = reduceQuestionnairePresentation(state, { type: "cancel" });
		}
		return toRawQuestionnaireOutcome(state);
	} };
}

async function presentQuestion(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
): Promise<QuestionnairePresentationState> {
	const index = state.activeQuestionIndex;
	const question = state.request.questions[index]!;
	const action = await ui.select(questionTitle(question, index), actionsFor(state, question));
	if (action === undefined || !actionsFor(state, question).includes(action)) return cancel(state);
	if (action === "Cancel") return cancel(state);
	if (action === "Back") return reduceQuestionnairePresentation(state, { type: "focus-question", questionIndex: index - 1 });
	if (action === "Skip") return moveTo(state, index + 1);
	if (action === "Submit partial") return reduceQuestionnairePresentation(state, { type: "submit-partial" });
	if (action === "Next" || action === "Submit") {
		const committed = reduceQuestionnairePresentation(state, { type: "next" });
		return action === "Submit" ? reduceQuestionnairePresentation(committed, { type: "submit-partial" }) : moveTo(committed, index + 1);
	}
	if (action === "Add question note") return editQuestionNote(ui, state, index);
	if (action === "Add global note") return editGlobalNote(ui, state);
	if (action === "Use custom text") return editCustom(ui, state, index);
	return chooseOption(ui, state, question, index);
}

function actionsFor(state: QuestionnairePresentationState, question: FrozenQuestion): string[] {
	const index = state.activeQuestionIndex;
	return [
		question.multiSelect ? "Choose options" : "Choose an option",
		"Use custom text",
		"Add question note",
		"Add global note",
		...(index > 0 ? ["Back"] : []),
		...(state.committed[index] === undefined ? ["Skip"] : []),
		...(index === state.request.questions.length - 1 ? ["Submit"] : ["Next"]),
		"Submit partial",
		"Cancel",
	];
}

async function chooseOption(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
	question: FrozenQuestion,
	index: number,
): Promise<QuestionnairePresentationState> {
	const label = await ui.select(questionTitle(question, index), question.options.map((option) => option.label));
	if (label === undefined || !question.options.some((option) => option.label === label)) return cancel(state);
	const options = reduceQuestionnairePresentation(state, { type: "set-tab", questionIndex: index, tab: "options" });
	return question.multiSelect
		? reduceQuestionnairePresentation(options, { type: "toggle-option", questionIndex: index, label })
		: reduceQuestionnairePresentation(options, { type: "select-option", questionIndex: index, label });
}

async function editCustom(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
	index: number,
): Promise<QuestionnairePresentationState> {
	const value = await ui.editor("Custom response", state.customDrafts[index]);
	if (value === undefined) return cancel(state);
	const custom = reduceQuestionnairePresentation(state, { type: "set-custom-draft", questionIndex: index, value });
	return reduceQuestionnairePresentation(custom, { type: "set-tab", questionIndex: index, tab: "custom" });
}

async function editQuestionNote(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
	index: number,
): Promise<QuestionnairePresentationState> {
	const value = await ui.editor("Question note", state.questionNotes[index]);
	return value === undefined ? cancel(state) : reduceQuestionnairePresentation(state, { type: "set-question-note", questionIndex: index, value });
}

async function editGlobalNote(
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	state: QuestionnairePresentationState,
): Promise<QuestionnairePresentationState> {
	const value = await ui.editor("Global note", state.globalNote);
	return value === undefined ? cancel(state) : reduceQuestionnairePresentation(state, { type: "set-global-note", value });
}

function moveTo(state: QuestionnairePresentationState, index: number): QuestionnairePresentationState {
	return index < state.request.questions.length
		? reduceQuestionnairePresentation(state, { type: "focus-question", questionIndex: index })
		: state;
}

function cancel(state: QuestionnairePresentationState): QuestionnairePresentationState {
	return reduceQuestionnairePresentation(state, { type: "cancel" });
}

function questionTitle(question: FrozenQuestion, index: number): string {
	const options = question.options.map((option) => [
		option.label,
		option.description,
		...(option.preview === undefined ? [] : [`Static preview: ${option.preview}`]),
	].join("\n")).join("\n\n");
	return `Question ${index + 1}: ${question.header}\n${question.question}\n\nStatic preview (RPC; full TUI detail unavailable):\n${options}`;
}
