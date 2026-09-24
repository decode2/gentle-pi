import assert from "node:assert/strict";
import test from "node:test";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	type TUI,
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

const tui = { terminal: { rows: 24 }, requestRender() {} } as TUI;

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
		tui,
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

function mouseEvent(lines: string[], row: number, type: TuiMouseEvent["type"], width = 100): TuiMouseEvent {
	return {
		type,
		button: "left",
		x: 1,
		y: row,
		screenX: 1,
		screenY: row,
		width,
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

test("UM-01: keyboard Next and final Submit require separate actions after answering", () => {
	const { view, completed } = viewWithResult(two());

	view.handleInput(KEY.enter); // Select Alpha; do not advance or deliver yet.
	assert.equal(completed.length, 0);
	assert.match(render(view), /\bNext\b/, "UM-01: Next must be visible after selecting the first answer");
	view.handleInput(KEY.enter); // Activate Next.
	assert.equal(view.activeQuestion, 1);

	view.handleInput(KEY.enter); // Select Gamma; do not deliver yet.
	assert.equal(completed.length, 0, "UM-01: the final answer must not deliver the questionnaire");
	assert.match(render(view), /\bSubmit\b/);
	view.handleInput(KEY.enter); // Activate Submit.
	assert.equal(completed.length, 1);
	assert.deepEqual(completed[0], { cancelled: false, answers: [
		{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha" },
		{ questionIndex: 1, question: "Second?", kind: "option", answer: "Gamma" },
	] });
});

test("UM-01: earlier answers remain editable until explicit Submit", () => {
	const { view, completed } = viewWithResult(two());
	view.handleInput(KEY.enter); // Record the first answer.
	view.handleInput(KEY.enter); // Explicit Next, without submitting.
	view.handleInput(KEY.enter); // Record the second answer.
	assert.equal(completed.length, 0, "UM-01: completing all answers must not freeze earlier answers");

	view.handleInput(KEY.shiftTab);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Replace Alpha with Beta.
	assert.equal(completed.length, 0);
	assert.deepEqual(view.getResult().answers.map((answer) => answer.answer), ["Beta", "Gamma"]);
	view.handleInput(KEY.tab);
	assert.match(render(view), /\bSubmit\b/);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(completed[0]?.answers.map((answer) => answer.answer), ["Beta", "Gamma"]);
});

test("UM-01: an empty optional MULTI can be explicitly submitted", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);
	assert.match(render(view), /\bSubmit\b/, "UM-01: empty MULTI must offer Submit without a selection");
	view.handleInput(KEY.enter); // Activate Submit without toggling an option.
	assert.equal(completed.length, 1);
	assert.deepEqual(completed[0], { cancelled: false, answers: [
		{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: [] },
	] });
});

test("UM-01: custom draft and MULTI toggles survive editing before Submit", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);
	view.handleInput(KEY.space); // Keep One selected.
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Open custom editor.
	view.handleInput("draft note");
	view.handleInput(KEY.escape); // Return to choices, preserving draft.
	assert.match(render(view), /\[x\] One/);
	view.handleInput(KEY.enter); // Reopen custom editor.
	assert.match(plain(render(view)), /draft note/);
	view.handleInput(KEY.enter); // Accept custom answer, not the entire questionnaire.
	assert.equal(completed.length, 0, "UM-01: accepting custom text must not auto-submit");
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "custom", answer: "draft note", selected: ["One"] },
	]);
	assert.match(render(view), /\bSubmit\b/);
});

test("UM-01: pointer Submit accepts only the visible action hit span", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.enter); // Choose Alpha; action must remain reachable.
	const lines = view.render(100);
	const row = lines.findIndex((line) => /\bSubmit\b/.test(plain(line)));
	assert.ok(row >= 0, "UM-01: Submit must have a visible pointer target");
	const start = plain(lines[row]!).indexOf("Submit");
	const end = start + "Submit".length - 1;
	assert.equal(view.handleMouse({ ...mouseEvent(lines, row, "click"), x: end + 1 }), undefined,
		"a click immediately beyond Submit must not submit");
	assert.equal(completed.length, 0);
	assert.equal(view.handleMouse({ ...mouseEvent(lines, row, "click"), x: end })?.handled, true,
		"the final visible Submit cell must be actionable");
	assert.equal(completed.length, 1);
});

test("UM-01: pointer Submit delivers latest MULTI selection after commit and custom edit", () => {
	const results: QuestionnaireResult[] = [];
	for (const withCustom of [false, true]) {
		const { view, completed } = viewWithResult([
			question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
		]);
		view.handleInput(KEY.space); // Select One.
		if (withCustom) {
			view.handleInput(KEY.down[0]);
			view.handleInput(KEY.down[0]);
			view.handleInput(KEY.enter); // Open custom editor.
			view.handleInput("free note");
			view.handleInput(KEY.enter); // Commit custom answer with One selected.
			view.handleInput(KEY.up[0]); // Return from custom row to Two.
		} else {
			view.handleInput(KEY.enter); // Commit One as a MULTI answer.
			view.handleInput(KEY.down[0]); // Focus Two after commit.
		}
		view.handleInput(KEY.space); // Edit the committed answer by selecting Two.
		assert.equal(completed.length, 0, "editing MULTI must not deliver before Submit");
		assert.match(render(view), /\[x\] Two/);
		const lines = view.render(100);
		const row = lines.findIndex((line) => /\bSubmit\b/.test(plain(line)));
		assert.ok(row >= 0, "Submit must remain visible after editing MULTI");
		const x = plain(lines[row]!).indexOf("Submit");
		assert.equal(view.handleMouse({ ...mouseEvent(lines, row, "click"), x })?.handled, true);
		assert.equal(completed.length, 1, "pointer Submit must deliver exactly once");
		results.push(completed[0]!);
	}
	assert.deepEqual(results, [
		{ cancelled: false, answers: [
			{ questionIndex: 0, question: "Pick?", kind: "multi", answer: null, selected: ["One", "Two"] },
		] },
		{ cancelled: false, answers: [
			{ questionIndex: 0, question: "Pick?", kind: "custom", answer: "free note", selected: ["One", "Two"] },
		] },
	], "pointer Submit must deliver the latest MULTI selections after commit and custom edit");
});

test("UM-01: visible Cancel remains distinct from Submit", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.enter); // Draft an answer, but do not deliver it.
	const lines = view.render(100);
	const submitRow = lines.findIndex((line) => /\bSubmit\b/.test(plain(line)));
	const cancelRow = lines.findIndex((line) => /\bCancel\b/.test(plain(line)));
	assert.ok(submitRow >= 0 && cancelRow >= 0,
		"UM-01: Submit and Cancel must both be visible as separate actions");
	const cancelX = plain(lines[cancelRow]!).indexOf("Cancel");
	assert.equal(view.handleMouse({ ...mouseEvent(lines, cancelRow, "click"), x: cancelX })?.handled, true);
	assert.equal(completed.length, 1);
	assert.equal(completed[0]?.cancelled, true);
	assert.equal(completed[0]?.answers[0]?.answer, "Alpha");
});

test("UM-02: typed newline edits custom text without submitting it", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Open custom editor.
	view.handleInput("first");
	view.handleInput("\x1b[13;2~"); // Shift-Enter: editor newline, not custom commit.
	view.handleInput("second");
	assert.equal(completed.length, 0, "UM-02: typed newline must not deliver the questionnaire");
	view.handleInput(KEY.enter); // Commit custom text, not Submit.
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: "first\nsecond" },
	], "UM-02: typed newline must survive custom commit");
	assert.equal(completed.length, 0);
	view.handleInput(KEY.enter); // Explicit Submit only now.
	assert.equal(completed.length, 1);
});

test("UM-02: bracketed multiline paste normalizes CRLF CR and tabs before custom commit", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("\x1b[200~one\r\ntwo\rthree\tend\x1b[201~");
	view.handleInput(KEY.enter);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: "one\ntwo\nthree    end" },
	], "UM-02: bracketed paste must retain normalized multiline content");
	assert.equal(completed.length, 0, "custom commit is not Submit");
});

test("UM-02: large bracketed paste delivers expanded content instead of its marker", () => {
	const { view, completed } = viewWithResult(single());
	const pasted = `prefix ${"x".repeat(1100)} suffix`;
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	view.handleInput(KEY.enter);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: pasted },
	], "UM-02: large paste must expand its marker at custom commit");
	assert.equal(completed.length, 0);
});

test("UM-02: Tab Esc and reopen preserve separate drafts and the editing caret", () => {
	const { view, completed } = viewWithResult(two());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("start");
	view.handleInput("\x1b[13;2~");
	view.handleInput("end");
	view.handleInput("\x1b[D"); // Caret before the final d.
	view.handleInput(KEY.tab); // Save first draft while switching questions.
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("other");
	view.handleInput(KEY.escape); // Save second draft, without cancelling.
	view.handleInput(KEY.shiftTab);
	view.handleInput(KEY.enter); // Reopen first custom row at its prior caret.
	view.handleInput("!");
	view.handleInput(KEY.enter);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "custom", answer: "start\nen!d" },
	], "UM-02: returning to a draft must preserve newline and caret");
	view.handleInput(KEY.tab);
	view.handleInput(KEY.enter); // Reopen second custom row.
	view.handleInput(KEY.enter); // Commit its unchanged draft.
	assert.deepEqual(view.getResult().answers.map((answer) => answer.answer), ["start\nen!d", "other"]);
	assert.equal(completed.length, 0, "both custom commits still require explicit Submit");
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
});

test("UM-02: MULTI custom multiline answer keeps toggles until explicit Submit", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);
	view.handleInput(KEY.space);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("line one");
	view.handleInput("\x1b[13;2~");
	view.handleInput("line two");
	view.handleInput(KEY.escape);
	view.handleInput(KEY.enter); // Reopen the preserved MULTI custom draft.
	view.handleInput(KEY.enter); // Commit, not Submit.
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Pick?", kind: "custom", answer: "line one\nline two", selected: ["One"] },
	], "UM-02: MULTI custom multiline draft must keep its selected options");
	assert.equal(completed.length, 0);
	view.handleInput(KEY.enter);
	assert.deepEqual(completed[0]?.answers, view.getResult().answers);
	assert.equal(completed.length, 1, "MULTI custom text needs one explicit Submit");
});

test("UM-03a-preview: long split preview remains reachable with a short left body at 80x20", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as TUI;
	const end = "PREVIEW-TAIL-REACHABLE";
	const preview = `${"Long preview detail ".repeat(28)}\n${end}`;
	const view = new QuestionnaireView({
		questions: [question("Choose?", [option("Alpha", "Short description", preview)])],
		theme, tui: compactTui,
	});
	const before = view.render(80);
	assert.ok(before.length <= compactTui.terminal.rows - 2);
	assert.ok(before.some((line) => plain(line).includes("Submit")) &&
		before.some((line) => plain(line).includes("Cancel")), "actions remain visible below the split preview");
	assert.ok(!plain(before.join("\n")).includes(end), "the long preview must actually overflow initially");
	const ownedRow = before.findIndex((line) => plain(line).includes("Alpha"));
	assert.ok(ownedRow >= 0, "the left option owns a wheel target");
	const wheel = { ...mouseEvent(before, ownedRow, "wheel", 80), button: "none" as const, wheelDelta: 200 };
	assert.equal(view.handleMouse(wheel)?.handled, true,
		"UM-03a-preview: owned wheel must reveal the preview tail");
	const after = view.render(80);
	assert.ok(plain(after.join("\n")).includes(end),
		"UM-03a-preview: last distinctive preview content must be visible after owned wheel and rerender");
	assert.ok(after.length <= compactTui.terminal.rows - 2 &&
		after.some((line) => plain(line).includes("Submit")) &&
		after.some((line) => plain(line).includes("Cancel")), "footer remains visible after scrolling");
});

test("UM-03b-wheel: owned body text moves the slice but blank cells on its row fall through", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as TUI;
	const view = new QuestionnaireView({
		questions: [question("Choose?", Array.from({ length: 12 }, (_, i) =>
			option(`Route ${i}`, i === 0 ? "A" : `Detail ${i}: ${"wrapped description ".repeat(4)}`)))],
		theme, tui: compactTui,
	});
	const before = view.render(40);
	const row = before.findIndex((line) => plain(line).includes("Route 0"));
	assert.ok(row >= 0, "the short option label must be visible in an overflowing body");
	assert.ok(visibleWidth(plain(before[row]!).trimEnd()) < 30, "x30 must be beyond the rendered Route 0 owner");
	const wheel = { ...mouseEvent(before, row, "wheel", 40), button: "none" as const, wheelDelta: 3 };
	assert.equal(view.handleMouse({ ...wheel, x: 30 }), undefined,
		"UM-03b-wheel: blank cells beyond the rendered row owner must fall through");
	assert.deepEqual(view.render(40), before, "blank-cell wheel must not move the owned slice");
	assert.equal(view.handleMouse(wheel)?.handled, true, "wheel over owned option text must move the slice");
	assert.notDeepEqual(view.render(40), before, "owned wheel must show different body text");
});

test("UM-03b-wheel: zero delta and outward edges fall through without invalidating hit maps", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as TUI;
	const view = new QuestionnaireView({
		questions: [question("Choose?", Array.from({ length: 12 }, (_, i) =>
			option(`Route ${i}`, i === 0 ? "A" : `Detail ${i}: ${"wrapped description ".repeat(4)}`)))],
		theme, tui: compactTui,
	});
	const before = view.render(40);
	const row = before.findIndex((line) => plain(line).includes("Route 0"));
	assert.ok(row >= 0);
	const wheel = { ...mouseEvent(before, row, "wheel", 40), button: "none" as const };
	assert.equal(view.handleMouse({ ...wheel, wheelDelta: 0 }), undefined,
		"UM-03b-wheel: a zero-delta event cannot own a scroll movement");
	assert.equal(view.handleMouse({ ...wheel, wheelDelta: -1 }), undefined,
		"outward wheel at the top must fall through");
	assert.deepEqual(view.render(40), before);
	assert.equal(view.handleMouse({ ...wheel, wheelDelta: 1000 })?.handled, true);
	assert.equal(view.handleMouse(wheel), undefined, "movement invalidates the old hit map until rerender");
	const bottom = view.render(40);
	const bottomRow = bottom.findIndex((line) => plain(line).includes("Type something."));
	assert.ok(bottomRow >= 0, "custom option remains visible at the bottom");
	assert.equal(view.handleMouse({ ...mouseEvent(bottom, bottomRow, "wheel", 40),
		button: "none", wheelDelta: 1 }), undefined, "outward wheel at the bottom must fall through");
	assert.deepEqual(view.render(40), bottom);
});

test("UM-03b-wheel: oversized inline preview text scrolls but blank option cells fall through", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as TUI;
	const tail = "PREVIEW-TAIL-OWNED";
	const view = new QuestionnaireView({
		questions: [question("Choose?", [option("Alpha", "Short description",
			`${"Long preview detail ".repeat(28)}\n${tail}`)])],
		theme, tui: compactTui,
	});
	const before = view.render(80);
	assert.ok(!plain(before.join("\n")).includes(tail), "preview must overflow the inline body");
	const optionRow = before.findIndex((line) => plain(line).includes("Alpha"));
	const previewRow = before.findIndex((line) => plain(line).includes("Long preview detail"));
	assert.ok(optionRow >= 0 && previewRow >= 0, "option and inline preview must both be visible");
	assert.equal(view.handleMouse({ ...mouseEvent(before, optionRow, "wheel", 80),
		button: "none", wheelDelta: 200, x: 70 }), undefined,
		"UM-03b-wheel: inline layout does not grant blank option cells wheel ownership");
	assert.deepEqual(view.render(80), before);
	assert.equal(view.handleMouse({ ...mouseEvent(before, previewRow, "wheel", 80),
		button: "none", wheelDelta: 200, x: 8 })?.handled, true,
		"inline preview text is owned scrollable body content");
	assert.ok(plain(view.render(80).join("\n")).includes(tail), "wheel reveals the preview tail");
});

test("UM-03a: a 40x20 long wrapped body keeps Next Submit and Cancel reachable without answer-time delivery", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as TUI;
	const completed: QuestionnaireResult[] = [];
	const first = question("Choose a route with a deliberately long wrapped question?", Array.from({ length: 12 }, (_, i) =>
		option(`Route ${i}`, `Detail ${i}: ${"wrapped body text ".repeat(4)}`)));
	const view = new QuestionnaireView({ questions: [first, question("Finish?", [option("Yes")])],
		theme, tui: compactTui, onComplete: (result) => completed.push(result) });
	view.handleInput(KEY.enter); // Record Route 0, not Next.
	assert.equal(completed.length, 0);
	const narrow = view.render(40);
	assert.ok(narrow.length <= compactTui.terminal.rows - 2,
		"UM-03a: the view must leave room for both real native custom TUI borders at 40x20");
	assertFits(view, 40);
	assert.ok(narrow.some((line) => plain(line).includes("Next")) &&
		narrow.some((line) => plain(line).includes("Cancel")), "both actions must remain visible");
	const bodyBefore = plain(narrow.join("\n"));
	const wheel = { ...mouseEvent(narrow, 3, "wheel", 40), button: "none" as const, wheelDelta: 12 };
	assert.equal(view.handleMouse(wheel)?.handled, true, "body wheel must browse the clipped option list");
	const scrolled = view.render(40);
	assert.notEqual(plain(scrolled.join("\n")), bodyBefore, "the body must be browsable");
	const nextRow = scrolled.findIndex((line) => plain(line).includes("Next"));
	assert.equal(view.handleMouse({ ...mouseEvent(scrolled, nextRow, "click", 40), x: plain(scrolled[nextRow]!).indexOf("Next") })?.handled, true);
	assert.equal(view.activeQuestion, 1);
	assert.equal(completed.length, 0, "Next does not deliver");
	view.handleInput(KEY.enter); // Record Yes, not Submit.
	assert.equal(completed.length, 0);
	const final = view.render(40);
	assert.ok(final.length <= compactTui.terminal.rows - 2);
	const submitRow = final.findIndex((line) => plain(line).includes("Submit"));
	assert.ok(submitRow >= 0 && final.some((line) => plain(line).includes("Cancel")));
	assert.equal(view.handleMouse({ ...mouseEvent(final, submitRow, "click", 40), x: plain(final[submitRow]!).indexOf("Submit") })?.handled, true);
	assert.deepEqual(completed[0]?.answers.map((answer) => answer.answer), ["Route 0", "Yes"]);
	const cancelled: QuestionnaireResult[] = [];
	const other = new QuestionnaireView({ questions: [first], theme, tui: compactTui,
		onComplete: (result) => cancelled.push(result) });
	const otherLines = other.render(40);
	const cancelRow = otherLines.findIndex((line) => plain(line).includes("Cancel"));
	assert.ok(otherLines.length <= compactTui.terminal.rows - 2 && cancelRow >= 0);
	assert.equal(other.handleMouse({ ...mouseEvent(otherLines, cancelRow, "click", 40), x: plain(otherLines[cancelRow]!).indexOf("Cancel") })?.handled, true);
	assert.equal(cancelled[0]?.cancelled, true);
});

test("UM-03a: scrolling and width resize reject stale hits but fresh owned targets retain the Editor draft", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as TUI;
	const completed: QuestionnaireResult[] = [];
	const view = new QuestionnaireView({ questions: [question("Pick a route?", Array.from({ length: 10 }, (_, i) =>
		option(`Route ${i}`, `Description ${i} ${"wrap ".repeat(12)}`)))],
		theme, tui: compactTui, onComplete: (result) => completed.push(result) });
	for (let i = 0; i < 10; i++) view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Editor, then keep its uncommitted draft across scrolling.
	view.handleInput("preserved draft");
	view.handleInput(KEY.escape);
	for (let i = 0; i < 10; i++) view.handleInput(KEY.up[0]);
	view.handleInput(KEY.enter); // Record Route 0 without delivering.
	const before = view.render(40);
	const oldOptionRow = before.findIndex((line) => plain(line).includes("Route 0"));
	assert.ok(oldOptionRow >= 0);
	assert.equal(view.handleMouse({ ...mouseEvent(before, 3, "wheel", 40), button: "none" as const, wheelDelta: 10 })?.handled, true,
		"UM-03a: wheel must scroll the owned body without delivering");
	assert.equal(view.handleMouse(mouseEvent(before, oldOptionRow, "click", 40)), undefined,
		"a pointer from before the scroll cannot commit an obsolete cell");
	const scrolled = view.render(40);
	assert.notEqual(plain(scrolled.join("\n")), plain(before.join("\n")));
	const resized = view.render(48);
	const submitRow = resized.findIndex((line) => plain(line).includes("Submit"));
	assert.ok(submitRow >= 0);
	const submitX = plain(resized[submitRow]!).indexOf("Submit");
	assert.equal(view.handleMouse({ ...mouseEvent(scrolled, submitRow, "click", 40), x: submitX }), undefined,
		"old-width pointer geometry cannot hit a newly rendered action");
	assert.equal(view.handleMouse({ ...mouseEvent(resized, submitRow, "click", 48), x: submitX + 6 }), undefined,
		"blank cells adjacent to Submit cannot commit");
	assert.equal(completed.length, 0);
	for (let i = 0; i < 10; i++) view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Reopen the retained public Editor.
	assert.match(plain(render(view, 48)), /preserved draft/);
	view.handleInput(KEY.escape);
	const fresh = view.render(48);
	const freshRow = fresh.findIndex((line) => plain(line).includes("Submit"));
	assert.equal(view.handleMouse({ ...mouseEvent(fresh, freshRow, "click", 48), x: plain(fresh[freshRow]!).indexOf("Submit") })?.handled, true);
	assert.deepEqual(completed[0]?.answers.map((answer) => answer.answer), ["Route 0"]);
});

test("UM-03a-editor: long wrapped question keeps the real custom Editor draft and caret on screen", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as TUI;
	const completed: QuestionnaireResult[] = [];
	const longQuestion = question("Choose a route with enough wrapped context to fill the native viewport. ".repeat(14),
		Array.from({ length: 12 }, (_, i) => option(`Route ${i}`, `Detail ${i}: ${"wrapped text ".repeat(4)}`)));
	const makeView = () => new QuestionnaireView({ questions: [longQuestion], theme, tui: compactTui,
		onComplete: (result) => completed.push(result) });
	const view = makeView();
	for (let i = 0; i < longQuestion.options.length; i++) view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Open the real per-question Editor, not a simulated input.
	view.focused = true;
	const draft = "editor reachability draft";
	view.handleInput(draft);
	assert.equal(completed.length, 0, "opening and typing in Editor must not deliver");
	const lines = view.render(40);
	assert.ok(lines.length <= compactTui.terminal.rows - 2, "Editor must leave both native borders at 40x20");
	assert.ok(lines.some((line) => plain(line).includes(draft) && line.includes(CURSOR_MARKER)),
		"UM-03a-editor: draft and caret must remain visible in the 18-row native viewport");
	view.handleInput(KEY.enter); // Commit custom text, not Submit.
	assert.equal(completed.length, 0, "custom commit must not submit");
	assert.equal(view.getResult().answers[0]?.answer, draft);
	const actions = view.render(40);
	assert.ok(actions.some((line) => plain(line).includes("Submit")) &&
		actions.some((line) => plain(line).includes("Cancel")), "Submit and Cancel remain separate visible actions");
	view.handleInput(KEY.enter); // Explicit Submit.
	assert.deepEqual(completed[0], { cancelled: false, answers: [
		{ questionIndex: 0, question: longQuestion.question, kind: "custom", answer: draft },
	] });
	const cancelled = makeView();
	for (let i = 0; i < longQuestion.options.length; i++) cancelled.handleInput(KEY.down[0]);
	cancelled.handleInput(KEY.enter);
	cancelled.handleInput("discarded draft");
	cancelled.handleInput(KEY.escape); // Return to choices, not questionnaire cancellation.
	assert.equal(completed.length, 1);
	const cancelLines = cancelled.render(40);
	const cancelRow = cancelLines.findIndex((line) => plain(line).includes("Cancel"));
	assert.ok(cancelRow >= 0, "Cancel must stay visible after leaving Editor");
	assert.equal(cancelled.handleMouse({ ...mouseEvent(cancelLines, cancelRow, "click", 40),
		x: plain(cancelLines[cancelRow]!).indexOf("Cancel") })?.handled, true);
	assert.equal(completed[1]?.cancelled, true);
	assert.equal(completed[1]?.answers.length, 0, "Cancel must not submit an uncommitted draft");
});

test("pointer click on an editor text row after its header moves the caret", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("abcd");
	const lines = view.render(100);
	const headerRow = lines.findIndex((line) => plain(line).includes("Custom response"));
	const textRow = lines.findIndex((line) => plain(line).includes("abcd"));
	assert.ok(headerRow >= 0 && textRow > headerRow + 1, "editor text follows the custom header and border");
	assert.equal(view.handleMouse(mouseEvent(lines, headerRow, "click")), undefined,
		"the custom header does not belong to the editor");
	assert.equal(view.handleMouse(mouseEvent(lines, 1, "click")), undefined,
		"the blank tab spacer does not belong to the editor");
	assert.equal(view.handleMouse(mouseEvent(lines, textRow, "wheel")), undefined,
		"unhandled wheel events pass through");
	assert.equal(view.handleMouse(mouseEvent(lines, textRow, "drag")), undefined,
		"editor text selection remains the renderer's responsibility");
	const click = view.handleMouse(mouseEvent(lines, textRow, "click"));
	assert.equal(click?.handled, true);
	assert.equal(click?.target.component, view, "the container owns the mouse dispatch target");
	view.handleInput("X");
	view.handleInput(KEY.enter);
	assert.equal(view.getResult().answers[0]?.answer, "aXbcd",
		"a click on the visible text row positions the editing caret, not the header or border");
	assert.equal(completed.length, 0, "custom commit still requires explicit Submit");
});

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
		assert.equal(completed.length, 0, `select after ${JSON.stringify(down)} is not Submit`);
		view.handleInput(KEY.enter);
		assert.equal(completed.length, 1, `explicit Submit after ${JSON.stringify(down)} should finish`);
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
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.equal(view.getResult().answers[0]?.answer, "Beta");
});

test("single-select records on Enter and advances only on explicit Next", () => {
	const { view, completed } = viewWithResult(two());

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0, "the questionnaire is not done while a question is unanswered");
	assert.equal(view.getResult().answers.length, 1);
	assert.equal(view.activeQuestion, 0, "recording an answer does not activate Next");
	assert.match(render(view), /\bNext\b/);
	view.handleInput(KEY.enter);
	assert.equal(view.activeQuestion, 1);
	assert.match(render(view), /\[2\/2\]/);
	assert.match(render(view), /❯ Gamma/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0);
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha" },
		{ questionIndex: 1, question: "Second?", kind: "option", answer: "Gamma" },
	]);
});

test("multi-select toggles with space and commits the selected options before Submit", () => {
	const { view, completed } = viewWithResult([
		question("Pick?", [option("One"), option("Two")], { multiSelect: true }),
	]);
	assert.match(render(view), /\[ \] One/);

	assert.match(render(view), /\bSubmit\b/, "an empty multiSelect can also be submitted");

	view.handleInput(KEY.space);
	assert.match(render(view), /\[x\] One/);

	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.space);
	assert.match(render(view), /\[x\] Two/);

	view.handleInput(KEY.space);
	assert.match(render(view), /\[ \] Two/);

	view.handleInput(KEY.enter);
	assert.equal(completed.length, 0);
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

test("multi-select can commit a custom answer with the toggled options", () => {
	const { view } = viewWithResult([question("Pick?", [option("One"), option("Two")], { multiSelect: true })]);
	view.handleInput(KEY.space);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);

	assert.match(render(view), /Custom response/);
	view.handleInput("free note");
	view.handleInput(KEY.enter);

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

test("UM-04b: callable view cancel snapshots committed rows once and rejects late edits", () => {
	const { view, completed } = viewWithResult([
		question("First?", [option("Alpha", "First choice", "Preview A"), option("Beta")], { header: "First" }),
		question("Second?", [option("Gamma"), option("Delta")], { header: "Second" }),
	]);
	view.handleInput(KEY.enter); // Commit the preview-bearing first row.
	view.handleInput(KEY.enter); // Next; second remains uncommitted.
	const cancellable = view as QuestionnaireView & { cancel?: () => void };
	assert.equal(typeof cancellable.cancel, "function", "abort needs a callable view cancellation boundary");
	cancellable.cancel?.();
	const snapshot = { cancelled: true, answers: [
		{ questionIndex: 0, question: "First?", kind: "option", answer: "Alpha", preview: "Preview A" },
	] };
	assert.deepEqual(completed, [snapshot]);
	cancellable.cancel?.();
	view.handleInput(KEY.enter);
	view.handleInput(KEY.escape);
	assert.deepEqual(completed, [snapshot], "cancel and late input cannot deliver twice");
	assert.deepEqual(view.getResult(), snapshot);
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

test("pointer press focuses a row and click commits it", () => {
	const { view, completed } = viewWithResult(single());
	const lines = view.render(100);
	const betaRow = lines.findIndex((line) => line.includes("Beta"));
	assert.ok(betaRow >= 0);

	assert.equal(view.handleMouse(mouseEvent(lines, betaRow, "press"))?.handled, true);
	assert.equal(completed.length, 0, "press focuses but never answers");
	const afterPress = view.render(100);
	const betaRowAfterPress = afterPress.findIndex((line) => line.includes("Beta"));
	assert.equal(view.handleMouse(mouseEvent(afterPress, betaRowAfterPress, "click"))?.handled, true);
	assert.equal(completed.length, 0);
	const afterChoice = view.render(100);
	const submitRow = afterChoice.findIndex((line) => line.includes("Submit"));
	assert.equal(view.handleMouse(mouseEvent(afterChoice, submitRow, "click"))?.handled, true);
	assert.equal(completed.length, 1);
	assert.equal(view.getResult().answers[0]?.answer, "Beta");
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
	assert.equal(completed.length, 0);
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
