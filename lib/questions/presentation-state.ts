import type { FrozenQuestionnaireRequest, RawQuestionAnswer, RawQuestionnaireOutcome } from "./contract.ts";

export type QuestionnairePresentationTab = "options" | "custom";

type CommittedAnswer =
	| { readonly kind: "option"; readonly label: string }
	| { readonly kind: "custom"; readonly value: string | null }
	| { readonly kind: "multi"; readonly selected: readonly string[] };

export interface QuestionnairePresentationState {
	readonly request: FrozenQuestionnaireRequest;
	readonly activeQuestionIndex: number;
	readonly tabs: readonly QuestionnairePresentationTab[];
	readonly optionSelections: readonly (string | undefined)[];
	readonly multiSelections: readonly (readonly string[])[];
	readonly customDrafts: readonly (string | undefined)[];
	readonly questionNotes: readonly (string | undefined)[];
	readonly committed: readonly (CommittedAnswer | undefined)[];
	readonly globalNote?: string;
	readonly submitted: boolean;
	readonly cancelled: boolean;
}

export type QuestionnairePresentationAction =
	| { readonly type: "focus-question"; readonly questionIndex: number }
	| { readonly type: "set-tab"; readonly questionIndex: number; readonly tab: QuestionnairePresentationTab }
	| { readonly type: "select-option"; readonly questionIndex: number; readonly label: string }
	| { readonly type: "toggle-option"; readonly questionIndex: number; readonly label: string }
	| { readonly type: "set-custom-draft"; readonly questionIndex: number; readonly value: string }
	| { readonly type: "set-question-note"; readonly questionIndex: number; readonly value: string }
	| { readonly type: "set-global-note"; readonly value: string }
	| { readonly type: "next" }
	| { readonly type: "submit-partial" }
	| { readonly type: "cancel" };

export function createQuestionnairePresentationState(request: FrozenQuestionnaireRequest): QuestionnairePresentationState {
	const count = request.questions.length;
	return {
		request,
		activeQuestionIndex: 0,
		tabs: Array.from({ length: count }, () => "options"),
		optionSelections: Array.from({ length: count }, () => undefined),
		multiSelections: Array.from({ length: count }, () => []),
		customDrafts: Array.from({ length: count }, () => undefined),
		questionNotes: Array.from({ length: count }, () => undefined),
		committed: Array.from({ length: count }, () => undefined),
		submitted: false,
		cancelled: false,
	};
}

// Invalid indexes, labels, and question-kind mismatches are intentional no-ops.
export function reduceQuestionnairePresentation(
	state: QuestionnairePresentationState,
	action: QuestionnairePresentationAction,
): QuestionnairePresentationState {
	if (state.cancelled) return state;
	if (action.type === "focus-question") return questionAt(state, action.questionIndex)
		? { ...state, activeQuestionIndex: action.questionIndex } : state;
	if (action.type === "set-global-note") return state.globalNote === action.value
		? state : { ...state, globalNote: action.value };
	if (action.type === "submit-partial") return state.submitted ? state : { ...state, submitted: true };
	if (action.type === "cancel") return { ...state, cancelled: true };
	if (action.type === "next") return commitActiveQuestion(state);
	const question = questionAt(state, action.questionIndex);
	if (!question) return state;
	if (action.type === "set-tab") return state.tabs[action.questionIndex] === action.tab ? state
		: { ...state, tabs: replaceAt(state.tabs, action.questionIndex, action.tab) };
	if (action.type === "set-custom-draft") return state.customDrafts[action.questionIndex] === action.value ? state
		: { ...state, customDrafts: replaceAt(state.customDrafts, action.questionIndex, action.value) };
	if (action.type === "set-question-note") return state.questionNotes[action.questionIndex] === action.value ? state
		: { ...state, questionNotes: replaceAt(state.questionNotes, action.questionIndex, action.value) };
	if (!question.options.some((option) => option.label === action.label)) return state;
	if (action.type === "select-option") {
		return question.multiSelect || state.optionSelections[action.questionIndex] === action.label ? state
			: { ...state, optionSelections: replaceAt(state.optionSelections, action.questionIndex, action.label) };
	}
	if (!question.multiSelect) return state;
	const selected = state.multiSelections[action.questionIndex]!;
	const next = selected.includes(action.label)
		? selected.filter((label) => label !== action.label)
		: [...selected, action.label];
	return { ...state, multiSelections: replaceAt(state.multiSelections, action.questionIndex, next) };
}

export function toRawQuestionnaireOutcome(state: QuestionnairePresentationState): RawQuestionnaireOutcome {
	const answers = state.committed.flatMap((committed, questionIndex) => {
		if (!committed) return [];
		const question = state.request.questions[questionIndex]!;
		const notes = state.questionNotes[questionIndex];
		const answer = rawAnswer(questionIndex, question.question, question.options, committed);
		return [{ ...answer, ...(notes === undefined ? {} : { notes }) }];
	});
	return {
		correlationId: state.request.correlationId,
		answers,
		cancelled: state.cancelled,
		...(state.globalNote === undefined ? {} : { globalNote: state.globalNote }),
	};
}

function commitActiveQuestion(state: QuestionnairePresentationState): QuestionnairePresentationState {
	const index = state.activeQuestionIndex;
	const question = state.request.questions[index]!;
	let committed: CommittedAnswer | undefined;
	if (state.tabs[index] === "custom") {
		committed = { kind: "custom", value: state.customDrafts[index] ?? null };
	} else if (question.multiSelect) {
		const selected = question.options
			.filter((option) => state.multiSelections[index]!.includes(option.label))
			.map((option) => option.label);
		committed = { kind: "multi", selected };
	} else {
		const label = state.optionSelections[index];
		if (label !== undefined) committed = { kind: "option", label };
	}
	return committed === undefined ? state : { ...state, committed: replaceAt(state.committed, index, committed) };
}

function rawAnswer(
	questionIndex: number,
	question: string,
	options: FrozenQuestionnaireRequest["questions"][number]["options"],
	committed: CommittedAnswer,
): RawQuestionAnswer {
	if (committed.kind === "custom") {
		return { questionIndex, question, kind: "custom", answer: committed.value };
	}
	if (committed.kind === "multi") {
		return { questionIndex, question, kind: "multi", answer: null, selected: [...committed.selected] };
	}
	const selected = options.find((option) => option.label === committed.label)!;
	return {
		questionIndex,
		question,
		kind: "option",
		answer: selected.label,
		...(selected.preview === undefined ? {} : { preview: selected.preview }),
	};
}

function questionAt(state: QuestionnairePresentationState, index: number) {
	return Number.isInteger(index) && index >= 0 ? state.request.questions[index] : undefined;
}

function replaceAt<T>(values: readonly T[], index: number, value: T): T[] {
	return [...values.slice(0, index), value, ...values.slice(index + 1)];
}
