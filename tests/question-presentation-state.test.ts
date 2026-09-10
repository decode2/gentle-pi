import assert from "node:assert/strict";
import test from "node:test";
import type { QuestionnairePresentationAction } from "../lib/questions/presentation-state.ts";
import {
	createQuestionnairePresentationState,
	reduceQuestionnairePresentation,
	toRawQuestionnaireOutcome,
} from "../lib/questions/presentation-state.ts";
import { validateAndFormat } from "../lib/questions/response.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

const input = {
	questions: [{
		question: "Choose a delivery path",
		header: "Delivery",
		options: [
			{ label: "Direct\nroute", description: "One step.", preview: "Use\nthe direct path." },
			{ label: "Staged", description: "Several steps." },
		],
	}, {
		question: "Choose checks",
		header: "Checks",
		multiSelect: true,
		options: [
			{ label: "Unit", description: "Fast." },
			{ label: "Integration", description: "Broad." },
		],
	}],
};

function request() {
	const created = createFrozenQuestionnaireRequest("presentation-correlation", input);
	assert.equal(created.ok, true);
	if (!created.ok) throw new Error("fixture must be valid");
	return created.request;
}

function apply(actions: QuestionnairePresentationAction[]) {
	return actions.reduce(reduceQuestionnairePresentation, createQuestionnairePresentationState(request()));
}

function valid(state: ReturnType<typeof createQuestionnairePresentationState>) {
	const outcome = toRawQuestionnaireOutcome(state);
	const formatted = validateAndFormat(state.request, outcome);
	assert.equal(formatted.ok, true, "presentation output must satisfy validateAndFormat");
	return outcome;
}

test("commits exact authored single-select labels and only their selected preview", () => {
	const outcome = valid(apply([
		{ type: "focus-question", questionIndex: 0 },
		{ type: "select-option", questionIndex: 0, label: "Direct\nroute" },
		{ type: "next" },
	]));
	assert.deepEqual(outcome.answers, [{
		questionIndex: 0,
		question: "Choose a delivery path",
		kind: "option",
		answer: "Direct\nroute",
		preview: "Use\nthe direct path.",
	}]);
});

test("keeps drafts, notes, and tab moves unanswered until an explicit next", () => {
	const outcome = valid(apply([
		{ type: "set-custom-draft", questionIndex: 0, value: "My\nfree-form path" },
		{ type: "set-question-note", questionIndex: 0, value: "Note\nwithout an answer" },
		{ type: "set-global-note", value: "Global\nnote" },
		{ type: "set-tab", questionIndex: 0, tab: "custom" },
		{ type: "focus-question", questionIndex: 1 },
	]));
	assert.deepEqual(outcome.answers, []);
	assert.equal(outcome.globalNote, "Global\nnote");
});

test("commits deduplicated multi-select toggles in question order only on next", () => {
	const beforeNext = apply([
		{ type: "focus-question", questionIndex: 1 },
		{ type: "toggle-option", questionIndex: 1, label: "Unit" },
		{ type: "toggle-option", questionIndex: 1, label: "Integration" },
		{ type: "toggle-option", questionIndex: 1, label: "Unit" },
		{ type: "toggle-option", questionIndex: 1, label: "Unit" },
	]);
	assert.deepEqual(valid(beforeNext).answers, []);
	const outcome = valid(reduceQuestionnairePresentation(beforeNext, { type: "next" }));
	assert.deepEqual(outcome.answers, [{
		questionIndex: 1,
		question: "Choose checks",
		kind: "multi",
		answer: null,
		selected: ["Unit", "Integration"],
	}]);
});

test("uses the active tab to avoid ambiguous custom or option output", () => {
	const outcome = valid(apply([
		{ type: "focus-question", questionIndex: 0 },
		{ type: "select-option", questionIndex: 0, label: "Direct\nroute" },
		{ type: "set-custom-draft", questionIndex: 0, value: "Custom\npath" },
		{ type: "set-tab", questionIndex: 0, tab: "custom" },
		{ type: "next" },
	]));
	assert.deepEqual(outcome.answers, [{
		questionIndex: 0,
		question: "Choose a delivery path",
		kind: "custom",
		answer: "Custom\npath",
	}]);
	assert.equal("preview" in outcome.answers[0]!, false);
});

test("allows explicit multiline and empty custom drafts for multi-select questions", () => {
	for (const value of ["Custom\nchecks", ""]) {
		const outcome = valid(apply([
			{ type: "focus-question", questionIndex: 1 },
			{ type: "set-custom-draft", questionIndex: 1, value },
			{ type: "set-tab", questionIndex: 1, tab: "custom" },
			{ type: "next" },
		]));
		assert.deepEqual(outcome.answers, [{
			questionIndex: 1, question: "Choose checks", kind: "custom", answer: value,
		}]);
	}
});

test("switches multi-select custom drafts back to ordered option commits and preserves cancellation", () => {
	const partial = apply([
		{ type: "focus-question", questionIndex: 1 },
		{ type: "toggle-option", questionIndex: 1, label: "Integration" },
		{ type: "toggle-option", questionIndex: 1, label: "Unit" },
		{ type: "set-custom-draft", questionIndex: 1, value: "Discarded custom draft" },
		{ type: "set-tab", questionIndex: 1, tab: "custom" },
		{ type: "set-tab", questionIndex: 1, tab: "options" },
		{ type: "next" },
		{ type: "submit-partial" },
	]);
	const submitted = valid(partial);
	assert.deepEqual(submitted.answers, [{
		questionIndex: 1, question: "Choose checks", kind: "multi", answer: null, selected: ["Unit", "Integration"],
	}]);
	const cancelled = valid(reduceQuestionnairePresentation(partial, { type: "cancel" }));
	assert.equal(cancelled.cancelled, true);
	assert.deepEqual(cancelled.answers, submitted.answers);
});

test("partial submit and cancel retain valid committed answers and notes", () => {
	const partial = apply([
		{ type: "focus-question", questionIndex: 0 },
		{ type: "select-option", questionIndex: 0, label: "Staged" },
		{ type: "set-question-note", questionIndex: 0, value: "Review\nfirst" },
		{ type: "next" },
		{ type: "set-global-note", value: "Global\ncontext" },
		{ type: "submit-partial" },
	]);
	const submitted = valid(partial);
	assert.equal(submitted.cancelled, false);
	assert.deepEqual(submitted.answers[0], {
		questionIndex: 0, question: "Choose a delivery path", kind: "option", answer: "Staged", notes: "Review\nfirst",
	});
	const cancelled = valid(reduceQuestionnairePresentation(partial, { type: "cancel" }));
	assert.equal(cancelled.cancelled, true);
	assert.deepEqual(cancelled.answers, submitted.answers);
	assert.equal(cancelled.globalNote, "Global\ncontext");
});

test("updates immutably and rejects invalid indexes, labels, and incompatible toggles as no-ops", () => {
	const originalInput = structuredClone(input);
	const initial = createQuestionnairePresentationState(request());
	const changed = reduceQuestionnairePresentation(initial, { type: "set-global-note", value: "unchanged input" });
	assert.notStrictEqual(changed, initial);
	assert.deepEqual(input, originalInput);
	assert.deepEqual(valid(initial).answers, []);
	for (const action of [
		{ type: "focus-question", questionIndex: -1 },
		{ type: "set-tab", questionIndex: 9, tab: "custom" },
		{ type: "select-option", questionIndex: 0, label: "Unknown" },
		{ type: "toggle-option", questionIndex: 0, label: "Direct\nroute" },
	] satisfies QuestionnairePresentationAction[]) {
		assert.strictEqual(reduceQuestionnairePresentation(initial, action), initial);
	}
});
