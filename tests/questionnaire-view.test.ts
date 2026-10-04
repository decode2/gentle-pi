import assert from "node:assert/strict";
import test from "node:test";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	visibleWidth,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import {
	MIN_PREVIEW_WIDTH,
	QuestionnaireView,
	type QuestionnaireResult,
	type QuestionnaireTheme,
} from "../lib/questionnaire/questionnaire-view.ts";
import { CUSTOM_ROW_LABEL, type OptionData, type QuestionData } from "../lib/questionnaire/schema.ts";

const theme: QuestionnaireTheme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

const option = (label: string, description = `${label} description`, preview?: string): OptionData =>
	preview === undefined ? { label, description } : { label, description, preview };

const question = (
	text: string,
	options: OptionData[],
	overrides: { header?: string; multiSelect?: boolean } = {},
): QuestionData => ({
	question: text,
	header: overrides.header ?? "Header",
	options,
	...(overrides.multiSelect === undefined ? {} : { multiSelect: overrides.multiSelect }),
});

const single = (preview?: string): QuestionData[] => [
	question("Proceed?", [option("Alpha", "First choice", preview), option("Beta", "Second choice")]),
];

const two = (): QuestionData[] => [
	question("First?", [option("Alpha"), option("Beta")], { header: "First" }),
	question("Second?", [option("Gamma"), option("Delta")], { header: "Second" }),
];

function createView(
	questions: QuestionData[],
	options: { onComplete?: (result: QuestionnaireResult) => void; keybindings?: KeybindingsManager } = {},
): QuestionnaireView {
	return new QuestionnaireView({
		questions,
		theme,
		onComplete: options.onComplete,
		...(options.keybindings === undefined ? {} : { keybindings: options.keybindings }),
	});
}

function viewWithResult(questions: QuestionData[], keybindings?: KeybindingsManager) {
	const completed: QuestionnaireResult[] = [];
	const view = createView(questions, {
		onComplete: (result) => completed.push(result),
		...(keybindings === undefined ? {} : { keybindings }),
	});
	return { view, completed };
}

function render(view: QuestionnaireView, width = 100): string {
	return view.render(width).join("\n");
}

/** Strip SGR styling so assertions see the visible text, not cursor escape codes. */
function plain(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function assertFits(view: QuestionnaireView, width: number): void {
	for (const line of view.render(width)) {
		assert.ok(
			visibleWidth(line) <= width,
			`rendered line exceeds width ${width}: ${JSON.stringify(line)}`,
		);
	}
}

function mouseEvent(lines: string[], row: number, type: TuiMouseEvent["type"]): TuiMouseEvent {
	return {
		type,
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
}

// Real terminal key sequences: legacy (ESC [) and application-cursor (ESC O).
const KEY = {
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	enter: "\r",
	space: " ",
	tab: "\t",
	shiftTab: "\x1b[Z",
	escape: "\x1b",
} as const;

test("renders exactly one active question plus a tab strip for all questions", () => {
	const { view } = viewWithResult(two());
	const rendered = render(view);

	// Tab strip: progress plus every header, active one marked.
	assert.match(rendered, /\[1\/2\]/);
	assert.match(rendered, /▸ First/);
	assert.match(rendered, /Second/);

	// Only the first question body renders; the second body is absent.
	assert.match(rendered, /First\?/);
	assert.match(rendered, /❯ Alpha/);
	assert.doesNotMatch(rendered, /Gamma/);
	assert.doesNotMatch(rendered, /Delta/);
	assert.doesNotMatch(rendered, /Second\?/);
});

test("Tab and Shift-Tab switch the active question and preserve cursor and toggles", () => {
	const { view, completed } = viewWithResult([
		question("First?", [option("Alpha"), option("Beta")], { header: "First" }),
		question("Second?", [option("Gamma"), option("Delta")], { header: "Second", multiSelect: true }),
	]);

	view.handleInput(KEY.down[0]); // First: cursor -> Beta
	view.handleInput(KEY.tab);
	let rendered = render(view);
	assert.match(rendered, /\[2\/2\]/);
	assert.match(rendered, /▸ Second/);
	assert.match(rendered, /❯ \[ \] Gamma/);
	assert.doesNotMatch(rendered, /❯ Beta/);
	assert.doesNotMatch(rendered, /First\?/);

	view.handleInput(KEY.space); // Second: toggle Gamma
	assert.match(render(view), /❯ \[x\] Gamma/);

	view.handleInput(KEY.shiftTab);
	rendered = render(view);
	assert.match(rendered, /\[1\/2\]/);
	assert.match(rendered, /❯ Beta/); // cursor preserved
	assert.doesNotMatch(rendered, /Gamma/); // second body hidden again

	view.handleInput(KEY.tab);
	assert.match(render(view), /❯ \[x\] Gamma/); // toggle preserved
	assert.equal(completed.length, 0);
});

test("real key sequences drive the cursor and commit in legacy and application-cursor form", () => {
	for (const down of KEY.down) {
		const { view, completed } = viewWithResult(single());
		view.handleInput(down);
		assert.match(render(view), /❯ Beta/, `down sequence ${JSON.stringify(down)} should move the cursor`);
		view.handleInput(KEY.enter);
		assert.equal(completed.length, 0, "choice confirmation only stages the answer");
		assert.match(render(view), /\[Submit\]/);
		view.handleInput(KEY.enter);
		assert.equal(completed.length, 1, `explicit Submit after ${JSON.stringify(down)} should deliver`);
		assert.deepEqual(view.getResult().answers, [
			{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Beta" },
		]);
	}

	for (const up of KEY.up) {
		const { view } = viewWithResult(single());
		view.handleInput(KEY.down[0]);
		view.handleInput(KEY.down[0]);
		view.handleInput(up);
		assert.match(render(view), /❯ Beta/, `up sequence ${JSON.stringify(up)} should move the cursor back`);
	}
});

test("the injected KeybindingsManager drives the same navigation and commit", () => {
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS);
	const { view, completed } = viewWithResult(single(), keybindings);

	assert.ok(keybindings.matches(KEY.down[0], "tui.select.down"));
	view.handleInput(KEY.down[0]);
	assert.match(render(view), /❯ Beta/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0);
	assert.match(render(view), /\[Submit\]/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.equal(view.getResult().answers[0]?.answer, "Beta");
});

test("single-select stages on Enter and explicit Next advances before final Submit", () => {
	const { view, completed } = viewWithResult(two());

	view.handleInput(KEY.tab);
	view.handleInput(KEY.enter); // Stage the last question before the first is ready.
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "Submit cannot deliver an incomplete answer array");
	assert.equal(view.activeQuestion, 1);
	view.handleInput(KEY.shiftTab);
	assert.equal(completed.length, 0, "navigation never delivers staged answers");

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "staging all answers still requires explicit Submit");
	assert.equal(view.getResult().answers.length, 2, "navigation retains the staged last answer");
	assert.equal(view.activeQuestion, 0, "staging stays on the current question");
	assert.match(render(view), /\[Next\]/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "Next only navigates");
	assert.equal(view.activeQuestion, 1, "explicit Next advances to the next question");
	assert.match(render(view), /\[2\/2\]/);
	assert.match(render(view), /❯ Gamma/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "even the last answer only stages");
	assert.match(render(view), /\[Submit\]/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha" },
		{ questionIndex: 1, question: "Second?", kind: "option", answer: "Gamma" },
	]);
});

test("multi-select stages empty selections and toggles with space before explicit Submit", () => {
	const empty = viewWithResult([question("Pick?", [option("One"), option("Two")], { multiSelect: true })]);
	empty.view.handleInput(KEY.enter);
	assert.equal(empty.completed.length, 0, "an empty selection stages without delivery");
	assert.match(render(empty.view), /\[Submit\]/);
	assert.deepEqual(empty.view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: [] },
	]);
	empty.view.handleInput(KEY.enter);
	assert.deepEqual(empty.completed, [{
		cancelled: false,
		answers: [{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: [] }],
	}]);

	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);
	assert.match(render(view), /\[ \] One/);

	view.handleInput(KEY.enter); // Stage empty, then dirty it with a toggle.
	view.handleInput(KEY.space);
	assert.match(render(view), /\[x\] One/);
	const dirty = view.render(100);
	const actionRow = dirty.findIndex((line) => line.includes("[Submit]"));
	assert.ok(actionRow >= 0);
	view.handleMouse(mouseEvent(dirty, actionRow, "click"));
	assert.equal(completed.length, 0, "dirty toggles invalidate the previously staged answer");
	assert.deepEqual(view.getResult().answers, []);

	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.space);
	assert.match(render(view), /\[x\] Two/);

	view.handleInput(KEY.space);
	assert.match(render(view), /\[ \] Two/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0);
	assert.match(render(view), /\[Submit\]/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One"] },
	]);
});

test("custom row opens the editor, empty submit returns, and the draft survives a tab switch", () => {
	const { view, completed } = viewWithResult(two());

	// Move to the custom row on question one and open the editor.
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	assert.match(render(view), /Custom response/);
	assert.match(render(view), /> /);

	view.handleInput("   ");
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "a whitespace-only submission stays uncommitted");
	assert.doesNotMatch(render(view), /Custom response/);

	// Reopen, type a draft, switch away, and come back: the draft is preserved.
	view.handleInput(KEY.enter);
	view.handleInput("draft text");
	view.handleInput(KEY.tab);
	assert.equal(view.activeQuestion, 1, "tab switches question even while editing");
	view.handleInput(KEY.shiftTab);
	assert.equal(view.activeQuestion, 0);
	view.handleInput(KEY.enter); // still on the custom row
	assert.match(plain(render(view)), /draft text/, "the custom draft is restored on reopen");

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "one of two questions answered is not completion");
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "custom", answer: "draft text" },
	]);
});

test("multi-select can stage a custom answer with the toggled options before Submit", () => {
	const { view, completed } = viewWithResult([question("Pick?", [option("One"), option("Two")], { multiSelect: true })]);
	view.handleInput(KEY.space);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);

	assert.match(render(view), /Custom response/);
	view.handleInput("free note");
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "editor save only stages");
	assert.match(render(view), /\[Submit\]/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);

	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "custom", answer: "free note", selected: ["One"] },
	]);
});

test("preview renders beside the list only while the focused option has one", () => {
	const { view } = viewWithResult(single("Preview body line"));
	const wide = render(view, 100);
	assert.match(wide, /Preview body line/);
	assert.match(wide, /❯ Alpha/);

	view.handleInput(KEY.down[0]); // Beta has no preview
	const collapsed = render(view, 100);
	assert.doesNotMatch(collapsed, /Preview body line/);
	assert.match(collapsed, /❯ Beta/);
	assertFits(view, 100);
});

test("the preview pane wraps cleanly and never exceeds the terminal width", () => {
	const body = "lorem ipsum dolor sit amet ".repeat(12);
	const { view } = viewWithResult([
		question("Proceed?", [option("Alpha", "First choice", body), option("Beta")]),
	]);
	for (const width of [MIN_PREVIEW_WIDTH, 100, 120]) {
		assertFits(view, width);
	}
	assert.match(render(view, 100), /lorem ipsum/);
});

test("narrow widths render the preview inline without corrupting the body", () => {
	const { view } = viewWithResult(single("Inline preview body"));
	const narrow = render(view, 60);
	assert.match(narrow, /Inline preview body/);
	assert.match(narrow, /❯ Alpha/);
	assert.match(narrow, /Type something\./);
	assertFits(view, 60);
});

test("height stays bounded as the question count grows", () => {
	const one = viewWithResult([question("Only?", [option("A"), option("B")], { header: "Only" })]);
	const many = viewWithResult([
		question("One?", [option("A"), option("B")], { header: "One" }),
		question("Two?", [option("C"), option("D")], { header: "Two" }),
		question("Three?", [option("E"), option("F")], { header: "Three" }),
		question("Four?", [option("G"), option("H")], { header: "Four" }),
	]);

	const oneLines = one.view.render(100).length;
	const manyLines = many.view.render(100).length;
	assert.ok(
		manyLines <= oneLines + 2,
		`four questions must not stack bodies (one=${oneLines}, many=${manyLines})`,
	);
	// Only the first body renders, so later bodies stay absent.
	const rendered = render(many.view, 100);
	assert.doesNotMatch(rendered, /Two\?/);
	assert.doesNotMatch(rendered, /Four\?/);
	assert.match(rendered, /❯ A/);
});

test("Escape cancels the questionnaire with a cancelled result", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.escape);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult(), { cancelled: true, answers: [] });
});

test("focus propagates to the free-text input for IME cursor positioning", () => {
	const { view } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);

	view.focused = true;
	assert.ok(render(view).includes(CURSOR_MARKER), "a focused view positions the input cursor");

	view.focused = false;
	assert.ok(!render(view).includes(CURSOR_MARKER), "an unfocused view hides the input cursor");
});

test("a committed option carries its preview on the answer row", () => {
	const { view } = viewWithResult(single("Preview body line"));
	view.handleInput(KEY.enter);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Alpha", preview: "Preview body line" },
	]);
});

test("pointer press focuses rows and actions; click stages or explicitly advances/submits", () => {
	const { view, completed } = viewWithResult(single());
	const lines = view.render(100);
	const betaRow = lines.findIndex((line) => line.includes("Beta"));
	assert.ok(betaRow >= 0);

	assert.equal(view.handleMouse(mouseEvent(lines, betaRow, "press"))?.handled, true);
	assert.equal(completed.length, 0, "press focuses but never answers");
	const afterPress = view.render(100);
	const betaRowAfterPress = afterPress.findIndex((line) => line.includes("Beta"));
	assert.equal(view.handleMouse(mouseEvent(afterPress, betaRowAfterPress, "click"))?.handled, true);
	assert.equal(completed.length, 0, "choice click stages without delivery");
	const staged = view.render(100);
	const submitRow = staged.findIndex((line) => line.includes("[Submit]"));
	assert.ok(submitRow >= 0);
	assert.equal(view.handleMouse(mouseEvent(staged, submitRow, "press"))?.handled, true);
	assert.equal(completed.length, 0, "action press only focuses");
	const focused = view.render(100);
	view.handleMouse(mouseEvent(focused, focused.findIndex((line) => line.includes("[Submit]")), "click"));
	assert.equal(completed.length, 1, "action click submits once");
	assert.equal(view.getResult().answers[0]?.answer, "Beta");

	for (const pressFirst of [false, true]) {
		const { view, completed } = viewWithResult(two());
		view.handleInput(KEY.tab);
		view.handleInput(KEY.enter); // Stage last first: all-ready must not mask a double activation.
		view.handleInput(KEY.shiftTab);
		view.handleInput(KEY.enter);
		assert.equal(view.getResult().answers.length, 2);
		assert.equal(completed.length, 0);
		let lines = view.render(100);
		const nextRow = lines.findIndex((line) => line.includes("[Next]"));
		assert.ok(nextRow >= 0);
		if (pressFirst) {
			assert.equal(view.handleMouse(mouseEvent(lines, nextRow, "press"))?.handled, true);
			lines = view.render(100);
			assert.match(lines.join("\n"), /\[1\/2\]/, "Next press must not advance before click");
			assert.equal(completed.length, 0);
		}
		view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("[Next]")), "click"));
		lines = view.render(100);
		assert.match(lines.join("\n"), /\[2\/2\]/);
		assert.equal(completed.length, 0, "one Next gesture must never submit staged answers");
		const submitRow = lines.findIndex((line) => line.includes("[Submit]"));
		assert.ok(submitRow >= 0);
		assert.equal(submitRow, nextRow, "equal-sized questions reuse the footer coordinate");
		if (pressFirst) {
			view.handleMouse(mouseEvent(lines, submitRow, "press"));
			lines = view.render(100);
			assert.equal(completed.length, 0, "separate Submit press still only focuses");
		}
		view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("[Submit]")), "click"));
		assert.deepEqual(completed, [{
			cancelled: false,
			answers: [
				{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha" },
				{ questionIndex: 1, question: "Second?", kind: "option", answer: "Gamma" },
			],
		}]);
		view.handleMouse(mouseEvent(lines, submitRow, "click"));
		view.handleInput(KEY.enter);
		view.handleInput(KEY.escape);
		assert.equal(completed.length, 1, "late click and keys are inert");
	}
});

test("pointer click toggles a multi-select option instead of committing", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);

	let lines = view.render(100);
	assert.equal(view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("One")), "click"))?.handled, true);
	assert.equal(completed.length, 0, "a multi-select click toggles without committing");
	assert.match(render(view), /\[x\] One/);

	// Clicking the same option again un-toggles it; still no commit.
	lines = view.render(100);
	view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("One")), "click"));
	assert.match(render(view), /\[ \] One/);
	assert.equal(completed.length, 0);

	// Toggle two options with the mouse, then commit with the keyboard.
	lines = view.render(100);
	view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("One")), "click"));
	lines = view.render(100);
	view.handleMouse(mouseEvent(lines, lines.findIndex((line) => line.includes("Two")), "click"));
	assert.match(render(view), /\[x\] One/);
	assert.match(render(view), /\[x\] Two/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "keyboard confirmation only stages the toggles");
	assert.match(render(view), /\[Submit\]/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One", "Two"] },
	]);
});

test("pointer click on the custom row opens the editor without committing", () => {
	for (const questions of [single(), [question("Pick?", [option("One"), option("Two")], { multiSelect: true })]]) {
		const { view, completed } = viewWithResult(questions);
		const lines = view.render(100);
		const customRow = lines.findIndex((line) => line.includes(CUSTOM_ROW_LABEL));
		assert.ok(customRow >= 0);

		assert.equal(view.handleMouse(mouseEvent(lines, customRow, "click"))?.handled, true);
		assert.match(render(view), /Custom response/);
		assert.equal(completed.length, 0, "opening the custom editor never commits");
	}
});

test("the custom row is always appended after the authored options", () => {
	const { view } = viewWithResult(single());
	const lines = view.render(100);
	const betaRow = lines.findIndex((line) => line.includes("Beta"));
	const customRow = lines.findIndex((line) => line.includes(CUSTOM_ROW_LABEL));
	assert.ok(betaRow >= 0 && customRow >= 0);
	assert.ok(customRow > betaRow);
});

test("every rendered line fits the width across 1-4 questions", () => {
	const questions = [
		question("One?", [option("A"), option("B", "B description", "preview ".repeat(20))], { header: "One" }),
		question("Two?", [option("C"), option("D")], { header: "Two", multiSelect: true }),
		question("Three?", [option("E"), option("F")], { header: "Three" }),
		question("Four?", [option("G"), option("H")], { header: "Four" }),
	];
	const { view } = viewWithResult(questions);
	for (const width of [40, 60, 80, 100, 140]) {
		assertFits(view, width);
	}
});
