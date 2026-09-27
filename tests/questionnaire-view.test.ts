import assert from "node:assert/strict";
import test from "node:test";
import { getSelectListTheme } from "@earendil-works/pi-coding-agent";
import {
	CURSOR_MARKER,
	KeybindingsManager,
	TUI_KEYBINDINGS,
	visibleWidth,
	type EditorTheme,
	type TUI,
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
const tui = { terminal: { rows: 24 }, requestRender() {} } as unknown as TUI;
const editorTheme: EditorTheme = {
	borderColor: (text) => text,
	selectList: getSelectListTheme(),
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
		editorTheme,
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

test("UM-02: typed Shift-Enter newline differs from custom commit and explicit Submit", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Open custom editor.
	view.handleInput("first");
	view.handleInput("\x1b[13;2~"); // Shift-Enter inserts a newline instead of committing.
	view.handleInput("second");
	assert.equal(completed.length, 0, "UM-02: a typed newline must not submit the questionnaire");
	view.handleInput(KEY.enter); // Commit custom text, not the questionnaire.
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: "first\nsecond" },
	], "UM-02: custom Enter must commit the multiline draft");
	assert.equal(completed.length, 0, "UM-02: custom commit is not explicit Submit");
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1, "UM-02: a separate Enter explicitly submits");
});

test("UM-02: bracketed paste normalizes CRLF CR and tabs", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("\x1b[200~one\r\ntwo\rthree\tend\x1b[201~");
	view.handleInput(KEY.enter);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "Proceed?", kind: "custom", answer: "one\ntwo\nthree    end" },
	], "UM-02: bracketed paste normalizes line endings and expands tabs");
	assert.equal(completed.length, 0, "UM-02: pasted text commit is not Submit");
});

test("UM-02: large bracketed paste expands to full text at least 1100 characters", () => {
	const { view, completed } = viewWithResult(single());
	const pasted = `prefix ${"x".repeat(1100)} suffix`;
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput(`\x1b[200~${pasted}\x1b[201~`);
	view.handleInput(KEY.enter);
	assert.ok(pasted.length >= 1100);
	assert.equal(view.getResult().answers[0]?.answer, pasted,
		"UM-02: the committed value must equal the expanded getExpandedText content");
	assert.equal(completed.length, 0);
});

test("UM-02: drafts and caret remain separate across Tab Esc and reopen", () => {
	const { view, completed } = viewWithResult(two());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("start");
	view.handleInput("\x1b[13;2~");
	view.handleInput("end");
	view.handleInput("\x1b[D"); // Place the caret before the final d.
	view.handleInput(KEY.tab); // Save the first draft while switching questions.
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("other");
	view.handleInput(KEY.escape); // Save the second draft without cancelling.
	view.handleInput(KEY.shiftTab);
	view.handleInput(KEY.enter); // Reopen the first custom row at its prior caret.
	view.handleInput("!");
	view.handleInput(KEY.enter);
	assert.deepEqual(view.getResult().answers, [
		{ questionIndex: 0, question: "First?", kind: "custom", answer: "start\nen!d" },
	], "UM-02: reopening a question restores its distinct draft and caret");
	view.handleInput(KEY.tab);
	view.handleInput(KEY.enter); // Reopen the second custom row.
	view.handleInput(KEY.enter); // Commit its unchanged draft.
	assert.deepEqual(view.getResult().answers.map((answer) => answer.answer), ["start\nen!d", "other"]);
	assert.equal(completed.length, 0, "UM-02: committing drafts does not submit the questionnaire");
	view.handleInput(KEY.enter);
	assert.equal(completed.length, 1);
});

test("UM-02: MULTI retains toggles with custom multiline text until explicit Submit", () => {
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
	], "UM-02: multiline custom text retains toggled options");
	assert.equal(completed.length, 0, "UM-02: MULTI custom commit still needs explicit Submit");
	view.handleInput(KEY.enter);
	assert.deepEqual(completed[0]?.answers, view.getResult().answers);
	assert.equal(completed.length, 1);
});

test("UM-02: editor pointer owns text target and restores caret position", () => {
	const { view, completed } = viewWithResult(single());
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter);
	view.handleInput("abcd");
	const lines = view.render(100);
	const headerRow = lines.findIndex((line) => plain(line).includes("Custom response"));
	const textRow = lines.findIndex((line) => plain(line).includes("abcd"));
	assert.ok(headerRow >= 0 && textRow > headerRow,
		"UM-02: the editable text row must be distinct from the custom header");
	const clickX = plain(lines[textRow]!).indexOf("abcd") + 1;
	const click = view.handleMouse({
		...mouseEvent(lines, textRow, "click"),
		x: clickX,
		screenX: clickX,
	});
	assert.equal(click?.handled, true, "UM-02: clicking editor text is handled by its pointer owner");
	assert.equal(click?.target.component, view, "UM-02: the questionnaire container owns the dispatch target");
	view.handleInput("X");
	view.handleInput(KEY.enter);
	assert.equal(view.getResult().answers[0]?.answer, "aXbcd",
		"UM-02: pointer click restores the caret within the editor text");
	assert.equal(completed.length, 0, "UM-02: custom commit is not Submit");
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

test("UM-03a-preview: long split preview remains reachable at 80x20", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as unknown as TUI;
	const previewTail = "PREVIEW-TAIL-REACHABLE";
	const preview = `${"Long preview detail ".repeat(28)}\n${previewTail}`;
	const view = new QuestionnaireView({
		questions: [question("Choose?", [option("Alpha", "Short description", preview)])],
		theme,
		tui: compactTui,
		editorTheme,
	});
	const before = view.render(80);
	assert.ok(before.length <= compactTui.terminal.rows - 2, "split preview must fit the 18-row component area");
	assert.ok(before.some((line) => plain(line).includes("Submit")) &&
		before.some((line) => plain(line).includes("Cancel")), "actions remain reachable below the split preview");
	assert.ok(!plain(before.join("\n")).includes(previewTail), "the long preview must overflow before scrolling");
	const ownedRow = before.findIndex((line) => plain(line).includes("Alpha"));
	assert.ok(ownedRow >= 0, "the left option supplies an owned wheel target");
	const wheel = {
		...mouseEvent(before, ownedRow, "wheel"),
		button: "none" as const,
		width: 80,
		wheelDelta: 200,
	};
	assert.equal(view.handleMouse(wheel)?.handled, true, "owned wheel reveals the split preview tail");
	const after = view.render(80);
	assert.ok(plain(after.join("\n")).includes(previewTail), "the last preview content becomes visible after scrolling");
	assert.ok(after.length <= compactTui.terminal.rows - 2 &&
		after.some((line) => plain(line).includes("Submit")) &&
		after.some((line) => plain(line).includes("Cancel")), "both actions stay visible after scrolling");
});

test("UM-03a: 40x20 wrapped body keeps Next, Submit, and Cancel reachable without answer-time delivery", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as unknown as TUI;
	const completed: QuestionnaireResult[] = [];
	const first = question(
		"Choose a route with a deliberately long wrapped question?",
		Array.from({ length: 12 }, (_, index) =>
			option(`Route ${index}`, `Detail ${index}: ${"wrapped body text ".repeat(4)}`)),
	);
	const view = new QuestionnaireView({
		questions: [first, question("Finish?", [option("Yes")])],
		theme,
		tui: compactTui,
		editorTheme,
		onComplete: (result) => completed.push(result),
	});
	view.handleInput(KEY.enter); // Record Route 0, not Next.
	assert.equal(completed.length, 0, "answering must not deliver before an explicit action");
	let lines = view.render(40);
	assert.ok(lines.length <= compactTui.terminal.rows - 2, "wrapped body leaves room for both native borders");
	assert.ok(lines.some((line) => plain(line).includes("Next")) &&
		lines.some((line) => plain(line).includes("Cancel")), "Next and Cancel are visible on the first question");
	const bodyRow = lines.findIndex((line) => plain(line).includes("Route 0"));
	assert.ok(bodyRow >= 0);
	const wheel = {
		...mouseEvent(lines, bodyRow, "wheel"),
		button: "none" as const,
		width: 40,
		wheelDelta: 12,
	};
	assert.equal(view.handleMouse(wheel)?.handled, true, "wheel scrolls the owned wrapped body");
	lines = view.render(40);
	const nextRow = lines.findIndex((line) => plain(line).includes("Next"));
	assert.ok(nextRow >= 0);
	const nextX = plain(lines[nextRow]!).indexOf("Next");
	assert.equal(view.handleMouse({ ...mouseEvent(lines, nextRow, "click"), width: 40, x: nextX })?.handled, true);
	assert.equal(view.activeQuestion, 1);
	assert.equal(completed.length, 0, "Next advances without delivering answers");

	view.handleInput(KEY.enter); // Record Yes, not Submit.
	assert.equal(completed.length, 0, "the final answer also waits for explicit Submit");
	lines = view.render(40);
	const submitRow = lines.findIndex((line) => plain(line).includes("Submit"));
	assert.ok(submitRow >= 0 && lines.some((line) => plain(line).includes("Cancel")));
	const submitX = plain(lines[submitRow]!).indexOf("Submit");
	assert.equal(view.handleMouse({ ...mouseEvent(lines, submitRow, "click"), width: 40, x: submitX })?.handled, true);
	assert.deepEqual(completed[0]?.answers.map((answer) => answer.answer), ["Route 0", "Yes"]);

	const cancelled: QuestionnaireResult[] = [];
	const cancelView = new QuestionnaireView({
		questions: [first], theme, tui: compactTui, editorTheme, onComplete: (result) => cancelled.push(result),
	});
	const cancelLines = cancelView.render(40);
	assert.ok(cancelLines.length <= compactTui.terminal.rows - 2);
	const cancelRow = cancelLines.findIndex((line) => plain(line).includes("Cancel"));
	assert.ok(cancelRow >= 0, "Cancel remains reachable with the long wrapped body");
	const cancelX = plain(cancelLines[cancelRow]!).indexOf("Cancel");
	assert.equal(cancelView.handleMouse({ ...mouseEvent(cancelLines, cancelRow, "click"), width: 40, x: cancelX })?.handled, true);
	assert.equal(cancelled[0]?.cancelled, true);
	assert.equal(cancelled[0]?.answers.length, 0, "Cancel does not deliver an uncommitted answer");
});

test("UM-03a: scrolling and resize reject stale hits while fresh targets retain the real Editor draft", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as unknown as TUI;
	const completed: QuestionnaireResult[] = [];
	const pick = question("Pick a route?", Array.from({ length: 10 }, (_, index) =>
		option(`Route ${index}`, `Description ${index} ${"wrapped ".repeat(12)}`)));
	const view = new QuestionnaireView({
		questions: [pick], theme, tui: compactTui, editorTheme, onComplete: (result) => completed.push(result),
	});
	for (let index = 0; index < pick.options.length; index++) view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Open the real per-question Editor.
	view.handleInput("preserved draft");
	view.handleInput(KEY.escape); // Keep its uncommitted draft while returning to choices.
	for (let index = 0; index < pick.options.length; index++) view.handleInput(KEY.up[0]);
	view.handleInput(KEY.enter); // Record Route 0 without delivering.
	assert.equal(completed.length, 0);

	const before = view.render(40);
	const oldOptionRow = before.findIndex((line) => plain(line).includes("Route 0"));
	assert.ok(oldOptionRow >= 0);
	const wheel = {
		...mouseEvent(before, oldOptionRow, "wheel"),
		button: "none" as const,
		width: 40,
		wheelDelta: 10,
	};
	assert.equal(view.handleMouse(wheel)?.handled, true, "body scrolling stays owned by the view");
	assert.equal(view.handleMouse({ ...mouseEvent(before, oldOptionRow, "click"), width: 40 }), undefined,
		"a pre-scroll row hit cannot commit an obsolete cell");
	const scrolled = view.render(40);
	assert.notEqual(plain(scrolled.join("\n")), plain(before.join("\n")));
	const oldSubmitRow = scrolled.findIndex((line) => plain(line).includes("Submit"));
	assert.ok(oldSubmitRow >= 0);
	const oldSubmitX = plain(scrolled[oldSubmitRow]!).indexOf("Submit");
	const resized = view.render(48);
	assert.ok(resized.length <= compactTui.terminal.rows - 2, "the resized body remains bounded");
	assert.equal(view.handleMouse({
		...mouseEvent(scrolled, oldSubmitRow, "click"), width: 40, x: oldSubmitX,
	}), undefined, "a pre-resize pointer geometry cannot hit a fresh layout");
	assert.equal(completed.length, 0, "stale hits never deliver the questionnaire");

	for (let index = 0; index < pick.options.length; index++) view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Reopen the retained Editor draft.
	assert.match(plain(render(view, 48)), /preserved draft/);
	view.handleInput(KEY.enter); // Commit the draft, not Submit.
	assert.equal(completed.length, 0);
	assert.equal(view.getResult().answers[0]?.answer, "preserved draft");
	const fresh = view.render(48);
	const freshSubmitRow = fresh.findIndex((line) => plain(line).includes("Submit"));
	assert.ok(freshSubmitRow >= 0);
	const freshSubmitX = plain(fresh[freshSubmitRow]!).indexOf("Submit");
	assert.equal(view.handleMouse({
		...mouseEvent(fresh, freshSubmitRow, "click"), width: 48, x: freshSubmitX,
	})?.handled, true, "a fresh action target remains owned after resize");
	assert.equal(completed[0]?.answers[0]?.answer, "preserved draft");
});

test("UM-03a-editor: long wrapped question keeps the real custom Editor draft and caret on screen", () => {
	const compactTui = { terminal: { rows: 20 }, requestRender() {} } as unknown as TUI;
	const completed: QuestionnaireResult[] = [];
	const longQuestion = question(
		"Choose a route with enough wrapped context to fill the native viewport. ".repeat(14),
		Array.from({ length: 12 }, (_, index) => option(`Route ${index}`)),
	);
	const view = new QuestionnaireView({
		questions: [longQuestion], theme, tui: compactTui, editorTheme, onComplete: (result) => completed.push(result),
	});
	for (let index = 0; index < longQuestion.options.length; index++) view.handleInput(KEY.down[0]);
	view.handleInput(KEY.enter); // Open the real public Editor, not a simulated input.
	view.focused = true;
	const draft = "custom draft visible";
	view.handleInput(draft);
	view.handleInput("\x1b[D"); // Keep the caret inside the visible draft.
	assert.equal(completed.length, 0, "editing the custom response does not deliver");
	const lines = view.render(40);
	assert.ok(lines.length <= compactTui.terminal.rows - 2, "Editor fits inside the 18-row native viewport");
	const screen = lines.slice(0, compactTui.terminal.rows - 2);
	assert.ok(screen.some((line) => plain(line).replaceAll(CURSOR_MARKER, "").includes(draft) && line.includes(CURSOR_MARKER)),
		"the real Editor draft and caret remain visible on screen after long question wrapping");
	view.handleInput(KEY.escape); // Preserve, rather than discard, the draft.
	view.handleInput(KEY.enter); // Reopen it at the same per-question Editor.
	const reopened = view.render(40);
	assert.ok(reopened.slice(0, compactTui.terminal.rows - 2)
		.some((line) => plain(line).replaceAll(CURSOR_MARKER, "").includes(draft) && line.includes(CURSOR_MARKER)),
		"the real custom draft and caret survive closing and reopening");
	assert.equal(completed.length, 0);
});

test("UM-03a-boundary: non-scrollable owned body returns boundary and zero wheel events to host", () => {
	const view = createView([question("Pick?", [option("Only choice")])]);
	const wheelOnOption = (wheelDelta: number): TuiMouseEvent => {
		const lines = view.render(40), row = lines.findIndex((line) => plain(line).includes("Only choice"));
		assert.ok(lines.length < tui.terminal.rows - 2 && row >= 0, "short body renders its owned option row");
		return { ...mouseEvent(lines, row, "wheel"), button: "none", width: 40, wheelDelta };
	};
	const positive = view.handleMouse(wheelOnOption(1));
	const zero = view.handleMouse(wheelOnOption(0));
	assert.equal(positive, undefined, "positive wheel at the non-scrollable boundary must fall through");
	assert.equal(zero, undefined, "zero-delta wheel on the owned row must fall through");
});
