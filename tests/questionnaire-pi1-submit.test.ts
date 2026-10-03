import assert from "node:assert/strict";
import test from "node:test";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import {
	QuestionnaireView,
	type QuestionnaireResult,
	type QuestionnaireTheme,
} from "../lib/questionnaire/questionnaire-view.ts";
import { CUSTOM_ROW_LABEL, type OptionData, type QuestionData } from "../lib/questionnaire/schema.ts";

const theme: QuestionnaireTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
const ENTER = "\r";
const DOWN = "\x1b[B";

function question(text = "Proceed?", multiSelect = false): QuestionData {
	const options: OptionData[] = [
		{ label: "Alpha", description: "First choice" },
		{ label: "Beta", description: "Second choice" },
	];
	return { question: text, header: text === "Proceed?" ? "Header" : text, options, multiSelect };
}

function fixture(questions: QuestionData[] = [question()]) {
	const completed: QuestionnaireResult[] = [];
	const view = new QuestionnaireView({
		questions,
		theme,
		onComplete: (result) => completed.push(result),
	});
	return { view, completed };
}

function render(view: QuestionnaireView): string {
	return view.render(100).join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

function clickNamedLine(view: QuestionnaireView, label: string): void {
	const lines = view.render(100);
	const matches = lines.flatMap((line, index) => line.includes(label) ? [index] : []);
	assert.equal(matches.length, 1, `expected one rendered line containing ${label}`);
	const row = matches[0]!;
	const event: TuiMouseEvent = {
		type: "click",
		button: "left",
		x: 1,
		y: row,
		screenX: 1,
		screenY: row,
		width: 100,
		height: lines.length,
		shift: false,
		alt: false,
		ctrl: false,
	};
	view.handleMouse(event);
}

function assertLateInputInert(view: QuestionnaireView, completed: QuestionnaireResult[]): void {
	const snapshot = structuredClone(completed);
	view.handleInput(ENTER);
	view.handleInput("\x1b");
	view.handleInput(DOWN);
	assert.deepEqual(completed, snapshot);
	assert.equal(completed.length, 1);
}

test("UM09a Pi1 Submit: single choice waits for explicit Submit", () => {
	const { view, completed } = fixture();
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "answer confirmation must not deliver");
	assert.match(render(view), /\bSubmit\b/);
	view.handleInput(ENTER);
	assert.deepEqual(completed, [{
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Alpha" }],
	}]);
	assertLateInputInert(view, completed);
});

test("UM09a Pi1 Submit: nonempty MULTI waits and preserves option order", () => {
	const { view, completed } = fixture([question("Proceed?", true)]);
	view.handleInput(DOWN);
	view.handleInput(" ");
	view.handleInput("\x1b[A");
	view.handleInput(" ");
	assert.equal(completed.length, 0, "toggling is not delivery");
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "MULTI confirmation must not deliver");
	assert.match(render(view), /\bSubmit\b/);
	view.handleInput(ENTER);
	assert.deepEqual(completed, [{
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Proceed?", kind: "multi", answer: null, selected: ["Alpha", "Beta"] }],
	}]);
	assertLateInputInert(view, completed);
});

test("UM09a Pi1 Submit: custom editor save waits for explicit Submit", () => {
	const { view, completed } = fixture();
	view.handleInput(DOWN);
	view.handleInput(DOWN);
	assert.ok(render(view).includes(CUSTOM_ROW_LABEL));
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "opening the editor is not delivery");
	assert.match(render(view), /Custom response/);
	view.handleInput("Owned response");
	assert.equal(completed.length, 0, "editor draft is not delivery");
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "editor save must not deliver");
	assert.match(render(view), /\bSubmit\b/);
	view.handleInput(ENTER);
	assert.deepEqual(completed, [{
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: "Owned response" }],
	}]);
	assertLateInputInert(view, completed);
});

test("UM09a Pi1 Submit: Next navigates before ordered final Submit", () => {
	const { view, completed } = fixture([question("First?"), question("Second?")]);
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "first answer is not delivery");
	assert.match(render(view), /\[1\/2\]/, "answer confirmation must stay on its question");
	assert.match(render(view), /\bNext\b/);
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "Next is not delivery");
	assert.match(render(view), /\[2\/2\]/);
	assert.match(render(view), /Second\?/);
	view.handleInput(DOWN);
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "last answer must not deliver");
	assert.match(render(view), /\bSubmit\b/);
	view.handleInput(ENTER);
	assert.deepEqual(completed, [{
		cancelled: false,
		answers: [
			{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha" },
			{ questionIndex: 1, question: "Second?", kind: "option", answer: "Beta" },
		],
	}]);
	assertLateInputInert(view, completed);
});

test("UM09a Pi1 Submit: empty optional MULTI submits an empty selection", () => {
	const { view, completed } = fixture([question("Proceed?", true)]);
	view.handleInput(ENTER);
	assert.equal(completed.length, 0, "empty MULTI confirmation is not cancellation or delivery");
	assert.match(render(view), /\bSubmit\b/);
	view.handleInput(ENTER);
	assert.deepEqual(completed, [{
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Proceed?", kind: "multi", answer: null, selected: [] }],
	}]);
	assertLateInputInert(view, completed);
});

test("UM09a Pi1 Submit: mouse edits remain pending and Submit sends latest answer", () => {
	const { view, completed } = fixture();
	clickNamedLine(view, "First choice");
	assert.equal(completed.length, 0, "answer click must not deliver");
	assert.match(render(view), /\bSubmit\b/);
	clickNamedLine(view, "Second choice");
	assert.equal(completed.length, 0, "revisiting and editing must not deliver");
	clickNamedLine(view, "[Submit]");
	assert.deepEqual(completed, [{
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Beta" }],
	}]);
	assertLateInputInert(view, completed);
});

test("UM09a Pi1 Submit: unanswered Escape cancels once without submitting", () => {
	const { view, completed } = fixture([question("Proceed?", true)]);
	view.handleInput("\x1b");
	assert.deepEqual(completed, [{ cancelled: true, answers: [] }]);
	assertLateInputInert(view, completed);
});
