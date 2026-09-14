import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { StdinBuffer, stripTerminalSequences, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionnaireExternalEditor } from "../lib/questions/external-editor.ts";
import { QuestionnaireTuiPresentation } from "../lib/questions/tui-presentation-view.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

// Markdown delegates styling to the SDK's process-wide theme callbacks.
initTheme("dark");

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function request() {
	const result = createFrozenQuestionnaireRequest("view-correlation", { questions: [{
		question: "Choose \u001b[31ma route\u001b[0m", header: "Route", options: [
			{ label: "Direct", description: "Fast", preview: "exact preview" }, { label: "Staged", description: "Careful" },
		],
	}, {
		question: "Choose checks", header: "Checks", multiSelect: true, options: [
			{ label: "Unit", description: "Fast" }, { label: "Integration", description: "Broad" },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid fixture");
	return result.request;
}

function markdownRequest() {
	const result = createFrozenQuestionnaireRequest("markdown-correlation", { questions: [{
		question: "Choose a Markdown-aware route", header: "Route", options: [
			{ label: "Direct", description: "Fast", preview: "123456789012345678901234\n\n**Fast path**\n\n- keep the detail" },
			{ label: "Staged", description: "Careful" },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid Markdown fixture");
	return result.request;
}

function narrowMarkdownRequest() {
	const result = createFrozenQuestionnaireRequest("narrow-markdown-correlation", { questions: [{
		question: "Choose a narrow Markdown route", header: "Route", options: [
			{ label: "Direct", description: "Fast", preview: "alpha bravo charlie xxxx\n\n**Fast path**\n\n- keep the detail" },
			{ label: "Staged", description: "Careful" },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid narrow Markdown fixture");
	return result.request;
}

function view(done: (outcome: unknown) => void = () => {}) {
	let renders = 0;
	const component = new QuestionnaireTuiPresentation({ request: request(), tui: { terminal: { rows: 24 }, requestRender: () => { renders++; } } as TUI, theme, onDone: done });
	return { component, renders: () => renders };
}

const ARROW_UP = "\u001b[A";
const ARROW_DOWN = "\u001b[B";
const ARROW_LEFT = "\u001b[D";
const ARROW_RIGHT = "\u001b[C";
const ENTER = "\r";
const ESCAPE = "\u001b";
const SHIFT_TAB = "\u001b[Z";
// Keyboard stops use the option control's existing visible arrow prefix: "→ ".
const KEYBOARD_FOCUS_ORDER = ["Direct", "Staged", "Custom answer", "Submit", "Cancel"];

function keyboardRequest(multiSelect = false) {
	const result = createFrozenQuestionnaireRequest("keyboard-correlation", { questions: [{
		question: "Choose a route", header: "Route", options: [
			{ label: "Direct", description: "Fast" }, { label: "Staged", description: "Careful" },
		],
		...(multiSelect ? { multiSelect: true } : {}),
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid keyboard fixture");
	return result.request;
}

function keyboardView(done: (outcome: unknown) => void = () => {}, multiSelect = false) {
	return new QuestionnaireTuiPresentation({
		request: keyboardRequest(multiSelect), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone: done,
	});
}

function renderedText(component: QuestionnaireTuiPresentation, width = 80): string[] {
	return component.render(width).map((line) => stripTerminalSequences(line).trim());
}

type ActionLabel = "Next" | "Submit" | "Cancel";
interface ActionButton {
	readonly label: ActionLabel;
	readonly focused: boolean;
}

function actionButtons(line: string): ActionButton[] {
	const buttons: ActionButton[] = [];
	const value = line.trim();
	let cursor = 0;
	while (cursor < value.length) {
		if (buttons.length > 0) {
			const separator = /^\s+/.exec(value.slice(cursor));
			if (!separator) return [];
			cursor += separator[0].length;
		}
		const match = /^(→\s*)?(?:\[\s*(Next|Submit|Cancel)\s*\]|(Next|Submit|Cancel))/.exec(value.slice(cursor));
		if (!match) return [];
		buttons.push({ label: (match[2] ?? match[3]) as ActionLabel, focused: match[1] !== undefined });
		cursor += match[0].length;
	}
	return buttons;
}

function isFocusedControlLine(line: string, label: string): boolean {
	if (actionButtons(line).some((button) => button.label === label && button.focused)) return true;
	if (line === `→ ${label}` || line === `→ [${label}]`) return true;
	const marker = `→ ${label}`;
	const markerIndex = line.indexOf(marker);
	if (markerIndex >= 0 && (line.length === markerIndex + marker.length || /\s/.test(line[markerIndex + marker.length]!))) return true;
	for (const prefix of ["→ ( ) ", "→ (●) ", "→ [ ] ", "→ [x] "]) {
		const control = `${prefix}${label}`;
		const suffix = line.startsWith(control) ? line.slice(control.length) : undefined;
		if (suffix === "" || /^ *│/.test(suffix ?? "")) return true;
	}
	return false;
}

function focusedControl(lines: readonly string[], label: string): number {
	const row = lines.findIndex((line) => isFocusedControlLine(line, label));
	assert.ok(row >= 0, `keyboard focus is visible on ${label}`);
	return row;
}

function isOptionControlLine(line: string, label: string): boolean {
	for (const prefix of ["( ) ", "(●) ", "[ ] ", "[x] ", "→ ( ) ", "→ (●) ", "→ [ ] ", "→ [x] "]) {
		const control = `${prefix}${label}`;
		const suffix = line.startsWith(control) ? line.slice(control.length) : undefined;
		if (suffix === "" || /^ *│/.test(suffix ?? "")) return true;
	}
	return false;
}

function optionControlRow(lines: readonly string[], label: string): number {
	const row = lines.findIndex((line) => isOptionControlLine(line, label));
	assert.ok(row >= 0, `the option control row is visible for ${label}`);
	return row;
}

function actionRow(lines: readonly string[], label: ActionLabel): number {
	let row = -1;
	for (const [index, line] of lines.entries()) {
		if (actionButtons(line).some((button) => button.label === label)) row = index;
	}
	assert.ok(row >= 0, `the footer action row is visible for ${label}`);
	return row;
}

function assertFocusPath(component: QuestionnaireTuiPresentation, key: string, labels: readonly string[], width = 80): void {
	assert.ok(labels.length > 0, "keyboard focus path has a starting control");
	const maxSteps = labels.length + 3;
	focusedControl(renderedText(component, width), labels[0]!);
	for (let step = 1; step < labels.length; step++) {
		assert.ok(step < maxSteps, "keyboard focus walk remains bounded");
		component.handleInput(key);
		focusedControl(renderedText(component, width), labels[step]!);
	}
}

function focusCustomForKeyboard(component: QuestionnaireTuiPresentation, width = 48, label = "Custom answer"): void {
	const initial = renderedText(component, width);
	const optionCount = Math.max(2, initial.filter((line) => /^(?:→ )?(?:\([● ]\)|\[[x ]\])\s/.test(line)).length);
	const maxSteps = optionCount + 3;
	for (let step = 0; step < maxSteps; step++) {
		const lines = renderedText(component, width);
		if (lines.some((line) => isFocusedControlLine(line, label))) {
			component.handleInput(ENTER);
			return;
		}
		component.handleInput("\t");
	}
	assert.fail(`bounded keyboard traversal could not focus ${label}`);
}

function mouse(width: number, y = 0, height = 24): TuiMouseEvent {
	return { type: "click", button: "left", x: 0, y, screenX: 0, screenY: y, width, height, shift: false, alt: false, ctrl: false };
}

function pointer(type: "press" | "click", width: number, y: number, height: number): TuiMouseEvent {
	return { ...mouse(width, y, height), type };
}

function wheel(width: number, y: number, height: number, wheelDelta: number): TuiMouseEvent {
	return { type: "wheel", button: "none", x: 0, y, screenX: 0, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

function click(component: QuestionnaireTuiPresentation, label: string) {
	const lines = component.render(48);
	const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
	assert.ok(y >= 0, `layout contains ${label}`);
	component.handleMouse(mouse(48, y, lines.length));
}

function clickVisible(component: QuestionnaireTuiPresentation, label: string | RegExp, width = 20) {
	const lines = component.render(width);
	const y = lines.findIndex((line) => typeof label === "string"
		? stripTerminalSequences(line).includes(label)
		: label.test(stripTerminalSequences(line)));
	assert.ok(y >= 0, `${width}-column layout contains ${String(label)}`);
	component.handleMouse(mouse(width, y, lines.length));
}

test("arrow navigation traverses options, Custom answer, primary, and Cancel with visible focus", () => {
	const outcomes: unknown[] = [];
	const component = keyboardView((outcome) => outcomes.push(outcome));
	const initial = renderedText(component);
	assert.ok(initial.some((line) => line.includes("Custom answer")), "Custom answer is always visible without a selection");
	assertFocusPath(component, ARROW_DOWN, KEYBOARD_FOCUS_ORDER);
	assert.equal(outcomes.length, 0, "focus movement does not complete the questionnaire");
	assert.doesNotMatch(renderedText(component).join("\n"), /\(●\)/, "focus movement does not select an option");
	component.handleInput(ARROW_DOWN);
	focusedControl(renderedText(component), "Cancel");
	assert.equal(outcomes.length, 0, "down clamps at the outer focus boundary");

	assertFocusPath(component, ARROW_UP, [...KEYBOARD_FOCUS_ORDER].reverse());
	component.handleInput(ARROW_UP);
	focusedControl(renderedText(component), "Direct");
	assert.equal(outcomes.length, 0, "up clamps at the outer focus boundary");

	component.handleInput(ENTER);
	assert.match(renderedText(component).join("\n"), /→ \(●\) Direct/, "Enter selects an option without submitting");
	assert.equal(outcomes.length, 0);
	assertFocusPath(component, ARROW_DOWN, KEYBOARD_FOCUS_ORDER.slice(0, 4));
	component.handleInput(ENTER);
	assert.deepEqual(outcomes, [{ correlationId: "keyboard-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose a route", kind: "option", answer: "Direct",
	}] }], "Enter on the focused primary submits the selected option");

	const cancelled: unknown[] = [];
	const cancelView = keyboardView((outcome) => cancelled.push(outcome));
	assertFocusPath(cancelView, ARROW_DOWN, KEYBOARD_FOCUS_ORDER);
	cancelView.handleInput(ENTER);
	assert.deepEqual(cancelled, [{ correlationId: "keyboard-correlation", cancelled: true, answers: [] }],
		"Enter on the independently focused Cancel action cancels without fabricating an answer");
});

test("pointer press synchronizes global focus before click activation", () => {
	const outcomes: unknown[] = [];
	const component = keyboardView((outcome) => outcomes.push(outcome));
	assertFocusPath(component, ARROW_DOWN, ["Direct", "Staged", "Custom answer", "Submit", "Cancel"]);
	let lines = renderedText(component);
	const direct = optionControlRow(lines, "Direct");
	assert.match(lines[direct]!, /^\( \) Direct(?: │|$)/, "the pointer target starts unselected");
	assert.equal(outcomes.length, 0);

	assert.equal(component.handleMouse(pointer("press", 80, direct, lines.length))?.handled, true);
	lines = renderedText(component);
	const focusMarkers = lines.filter((line) => line.startsWith("→ "));
	assert.equal(focusMarkers.length, 1, "pointer press leaves exactly one global focus marker");
	assert.ok(isFocusedControlLine(focusMarkers[0]!, "Direct"), "pointer press moves global focus to the pressed option");
	assert.equal(outcomes.length, 0, "pointer press does not commit or cancel");
	assert.match(lines[optionControlRow(lines, "Direct")]!, /^→ \( \) Direct(?: │|$)/,
		"pointer press changes focus without selecting the option");

	component.handleInput(ENTER);
	lines = renderedText(component);
	assert.match(lines[optionControlRow(lines, "Direct")]!, /^→ \(●\) Direct(?: │|$)/,
		"Enter activates the option after pointer focus synchronization");
	assert.equal(outcomes.length, 0, "option activation remains separate from questionnaire commit");
});

test("Tab and Shift+Tab traverse the same bounded focus order without opening Custom answer", () => {
	const outcomes: unknown[] = [];
	const component = keyboardView((outcome) => outcomes.push(outcome));
	assertFocusPath(component, "\t", KEYBOARD_FOCUS_ORDER);
	assert.equal(outcomes.length, 0);
	let visible = renderedText(component).join("\n");
	assert.doesNotMatch(visible, /Custom response \(Esc/, "focusing Custom answer does not auto-open the editor");
	assert.doesNotMatch(visible, /\(●\)/, "tab focus does not select an option");

	assertFocusPath(component, SHIFT_TAB, [...KEYBOARD_FOCUS_ORDER].reverse());
	assertFocusPath(component, "\t", KEYBOARD_FOCUS_ORDER.slice(0, 3));
	component.handleInput(ENTER);
	assert.match(renderedText(component).join("\n"), /Custom response \(Esc/, "Enter opens the focused custom answer editor");
	component.handleInput("draft");
	assert.equal(outcomes.length, 0, "typing a custom draft does not complete the questionnaire");
	component.handleInput("\t");
	focusedControl(renderedText(component), "Submit");
	visible = renderedText(component).join("\n");
	assert.match(visible, /draft/, "Tab closes the editor while retaining its draft");
	assert.equal(outcomes.length, 0);

	component.handleInput(SHIFT_TAB);
	focusedControl(renderedText(component), "Custom answer");
	assert.doesNotMatch(renderedText(component).join("\n"), /Custom response \(Esc/, "Shift+Tab returns to Custom answer without reopening its editor");
	component.handleInput(ENTER);
	assert.match(renderedText(component).join("\n"), /Custom response \(Esc/);
	component.handleInput(SHIFT_TAB);
	focusedControl(renderedText(component), "Staged");
	assert.doesNotMatch(renderedText(component).join("\n"), /Custom response \(Esc/, "Shift+Tab closes the editor while retaining focus outside it");
	component.handleInput("\t");
	focusedControl(renderedText(component), "Custom answer");
	component.handleInput(ENTER);
	assert.match(renderedText(component).join("\n"), /Custom response \(Esc/);
	assert.match(renderedText(component).join("\n"), /draft/, "Shift+Tab preserves the draft for a later editor reopen");
	component.handleInput(ESCAPE);
	focusedControl(renderedText(component), "Custom answer");
	assert.match(renderedText(component).join("\n"), /draft/, "Escape closes the editor without discarding its draft");
	assert.equal(outcomes.length, 0);
	component.handleInput(ESCAPE);
	assert.deepEqual(outcomes, [{ correlationId: "keyboard-correlation", cancelled: true, answers: [] }],
		"a second Escape outside the editor cancels the questionnaire");
});

test("custom editor arrows and Enter preserve cursor edits, newlines, and literal action letters", () => {
	const outcomes: unknown[] = [];
	const component = keyboardView((outcome) => outcomes.push(outcome));
	assertFocusPath(component, "\t", KEYBOARD_FOCUS_ORDER.slice(0, 3));
	component.handleInput(ENTER);
	component.handleInput("abcd");
	component.handleInput(ARROW_LEFT);
	component.handleInput(ARROW_LEFT);
	component.handleInput("X");
	component.handleInput(ARROW_RIGHT);
	component.handleInput(ENTER);
	component.handleInput("n/s");
	component.handleInput(ARROW_UP);
	component.handleInput(ARROW_DOWN);
	assert.equal(outcomes.length, 0, "editor arrows and literal n/s never trigger questionnaire actions");

	component.handleInput("\t");
	focusedControl(renderedText(component), "Submit");
	assert.match(renderedText(component).join("\n"), /abXc\nn\/sd/, "editor navigation retains the exact multiline draft");
	component.handleInput(ENTER);
	assert.deepEqual(outcomes, [{ correlationId: "keyboard-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose a route", kind: "custom", answer: "abXc\nn/sd",
	}] }], "keyboard Submit emits the exact custom draft without option selection");
});

test("multi-select Enter toggles focused options and waits for the primary action", () => {
	const outcomes: unknown[] = [];
	const component = keyboardView((outcome) => outcomes.push(outcome), true);
	focusedControl(renderedText(component), "Direct");
	component.handleInput(ENTER);
	assert.match(renderedText(component).join("\n"), /→ \[x\] Direct/);
	assert.equal(outcomes.length, 0, "selecting a multi-select option does not complete the questionnaire");
	component.handleInput(ARROW_DOWN);
	component.handleInput(ENTER);
	assert.match(renderedText(component).join("\n"), /→ \[x\] Staged/);
	assert.equal(outcomes.length, 0);
	assertFocusPath(component, ARROW_DOWN, ["Staged", "Custom answer", "Submit"]);
	component.handleInput(ENTER);
	assert.equal(outcomes.length, 1, "the primary action is the first keyboard action that completes multi-select");
});

test("Ctrl+G launches the external editor only from a custom-answer draft", async () => {
	const calls: string[] = [];
	const externalEditor: QuestionnaireExternalEditor = async (content) => {
		calls.push(content);
		return "edited externally";
	};
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {}, externalEditor,
	} as ConstructorParameters<typeof QuestionnaireTuiPresentation>[0] & { externalEditor: QuestionnaireExternalEditor });

	focusCustomForKeyboard(component);
	component.handleInput("draft before external edit");
	component.handleInput("\u0007");
	await Promise.resolve();

	assert.deepEqual(calls, ["draft before external edit"]);
});

type FutureExternalViewOptions = ConstructorParameters<typeof QuestionnaireTuiPresentation>[0] & {
	externalEditor?: QuestionnaireExternalEditor;
	onExternalEditorError?: (message: string) => void;
};

function externalView(externalEditor: QuestionnaireExternalEditor, onExternalEditorError: (message: string) => void = () => {}, localize?: (key: string, fallback: string) => string) {
	const outcomes: unknown[] = [];
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme,
		onDone: (outcome) => outcomes.push(outcome), externalEditor, onExternalEditorError, localize,
	} as FutureExternalViewOptions);
	return { component, outcomes };
}

async function settleExternalEditor(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

test("Ctrl+G updates the visible custom draft without completing, then Next and Submit commit its multiline result", async () => {
	const calls: string[] = [];
	const { component, outcomes } = externalView(async (draft) => {
		calls.push(draft);
		return "edited externally\nsecond line";
	});
	focusCustomForKeyboard(component);
	component.handleInput("draft before external edit");
	component.handleInput("\u0007");
	await settleExternalEditor();
	assert.deepEqual(calls, ["draft before external edit"]);
	assert.equal(outcomes.length, 0, "external editing does not complete the questionnaire");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /edited externally[\s\S]*second line/, "the active editor visibly contains the external result before commit");
	component.handleInput("\u001b");
	component.handleInput("n");
	component.handleInput("s");
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: "edited externally\nsecond line",
	}] }]);
});

test("Ctrl+G is ignored outside a custom-answer editor", async () => {
	const calls: string[] = [];
	const { component } = externalView(async (draft) => {
		calls.push(draft);
		return draft;
	});
	component.handleInput("\u0007");
	await settleExternalEditor();
	assert.deepEqual(calls, [], "Ctrl+G on options remains a no-op");
});

test("Ctrl+G coalesces a pending launch and permits a later launch after settlement", async () => {
	const calls: string[] = [];
	const resolvers: Array<(value: string) => void> = [];
	const { component } = externalView((draft) => {
		calls.push(draft);
		return new Promise((resolve) => resolvers.push(resolve));
	});
	focusCustomForKeyboard(component);
	component.handleInput("stable draft");
	component.handleInput("\u0007");
	component.handleInput("\u0007");
	await settleExternalEditor();
	assert.deepEqual(calls, ["stable draft"]);
	resolvers.shift()!("first result");
	await settleExternalEditor();
	component.handleInput("\u0007");
	await settleExternalEditor();
	assert.deepEqual(calls, ["stable draft", "first result"]);
	resolvers.shift()!("second result");
	await settleExternalEditor();
});

test("a rejected editor preserves the draft, reports localized failure, and clears the launch guard", async () => {
	const calls: string[] = [];
	const notices: string[] = [];
	const { component } = externalView(async (draft) => {
		calls.push(draft);
		if (calls.length === 1) throw new Error("editor failed");
		return "recovered draft";
	}, (message) => notices.push(message), (key, fallback) => key === "editor.failed" ? "Editor fehlgeschlagen" : fallback);
	focusCustomForKeyboard(component);
	component.handleInput("preserve me");
	component.handleInput("\u0007");
	await settleExternalEditor();
	assert.deepEqual(calls, ["preserve me"]);
	assert.deepEqual(notices, ["Editor fehlgeschlagen"]);
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /preserve me/, "a rejection retains the original visible draft");
	component.handleInput("\u0007");
	await settleExternalEditor();
	assert.deepEqual(calls, ["preserve me", "preserve me"]);
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /recovered draft/);
});

test("a deferred editor completion after disposal cannot resurrect the view", async () => {
	const calls: string[] = [];
	let resolveEditor!: (value: string) => void;
	const { component, outcomes } = externalView((draft) => {
		calls.push(draft);
		return new Promise((resolve) => { resolveEditor = resolve; });
	});
	focusCustomForKeyboard(component);
	component.handleInput("late draft");
	component.handleInput("\u0007");
	await settleExternalEditor();
	assert.deepEqual(calls, ["late draft"], "the launch reaches the injected editor before disposal coverage begins");
	component.dispose();
	resolveEditor("must not return");
	await settleExternalEditor();
	assert.deepEqual(component.render(48), []);
	assert.deepEqual(outcomes, []);
});

test("single-select preview uses a Markdown side panel while the Custom answer control stays discoverable", () => {
	const component = new QuestionnaireTuiPresentation({
		request: markdownRequest(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {},
	});
	const lines = component.render(64).map((line) => stripTerminalSequences(line));
	const preview = lines.findIndex((line) => line.includes("Preview:"));
	assert.ok(preview >= 0, "the focused option preview is visible");
	assert.match(lines[preview]!, /│\s*Preview:\s*$/, "the caption has its own side-panel line");
	const firstMarkdownLine = lines.findIndex((line) => line.includes("123456789012345678901234"));
	assert.ok(firstMarkdownLine >= 0, "the full first Markdown line survives the caption row");
	assert.notEqual(firstMarkdownLine, preview, "the caption does not share the first Markdown line");
	assert.match(lines.join("\n"), /Fast path/);
	assert.doesNotMatch(lines.join("\n"), /\*\*Fast path\*\*/,
		"Pi Markdown renders emphasis instead of exposing authored Markdown markers");
	assert.match(lines.join("\n"), /Custom answer/, "custom text remains discoverable in preview mode");
});

test("missing single-select previews clear the panel, while narrow terminals stack Markdown safely", () => {
	const component = new QuestionnaireTuiPresentation({
		request: markdownRequest(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {},
	});
	component.handleInput("\u001b[B");
	const missing = stripTerminalSequences(component.render(80).join("\n"));
	assert.doesNotMatch(missing, /Preview:|Fast path|keep the detail/, "a missing preview cannot retain the previous focused preview");
	assert.match(missing, /Custom answer/);

	const narrowComponent = new QuestionnaireTuiPresentation({
		request: markdownRequest(), tui: { terminal: { rows: 60 }, requestRender() {} } as TUI, theme, onDone() {},
	});
	const narrow = narrowComponent.render(20);
	assert.ok(narrow.every((line) => visibleWidth(line) <= 20));
	const narrowText = stripTerminalSequences(narrow.join("\n"));
	assert.match(narrowText, /Preview:\n[\s\S]*Fast path/);
	assert.match(narrowText, /Custom answer/);
});

test("narrow Markdown fallback keeps every preview row across viewport scroll", () => {
	const component = new QuestionnaireTuiPresentation({
		request: narrowMarkdownRequest(), tui: { terminal: { rows: 10 }, requestRender() {} } as TUI, theme, onDone() {},
	});
	const seen = new Set<string>();
	let previewRow: number | undefined;
	for (let attempt = 0; attempt < 20 && seen.size < 4; attempt++) {
		const lines = component.render(20);
		for (const [row, line] of lines.map((value) => stripTerminalSequences(value)).entries()) {
			if (line.trim().startsWith("Preview:")) {
				seen.add("caption");
				previewRow = row;
			}
			if (line.includes("alpha bravo charlie")) seen.add("first-line");
			if (line.trim() === "xxxx") seen.add("wrapped-tail");
			if (line.includes("keep the detail")) seen.add("last-line");
		}
		if (seen.size < 4) component.handleMouse(wheel(20, previewRow ?? 1, lines.length, 1));
	}
	assert.ok(seen.has("caption"), "the narrow caption occupies its own row");
	assert.ok(seen.has("first-line"), "the first wrapped Markdown row is visible");
	assert.ok(seen.has("wrapped-tail"), "the complete first Markdown line survives wrapping");
	assert.ok(seen.has("last-line"), "the final Markdown row survives scrolling");
});

test("renders authored options then Custom answer without obsolete tab chrome", () => {
	const lines = renderedText(view().component, 48);
	const direct = optionControlRow(lines, "Direct");
	const staged = optionControlRow(lines, "Staged");
	const custom = lines.findIndex((line) => line === "Custom answer");
	assert.ok(custom > Math.max(direct, staged), "Custom answer is rendered below every authored option");
	const primary = actionRow(lines, "Next");
	const cancel = actionRow(lines, "Cancel");
	assert.ok(custom < primary, "Custom answer precedes the primary action");
	assert.equal(primary, cancel, "primary and Cancel occupy one visual action row");
	assert.equal(lines.filter((line) => line === "Options" || line === "[Options]").length, 0,
		"the obsolete Options tab is not rendered");
	assert.equal(lines.filter((line) => line === "[Custom answer]").length, 0,
		"Custom answer is a control, not tab chrome");
});

test("keeps an open custom editor below options and makes Escape preserve rather than cancel its draft", () => {
	const outcomes: unknown[] = [];
	const component = view((outcome) => outcomes.push(outcome)).component;
	const width = 48;
	const initial = renderedText(component, width).join("\n");
	assert.match(initial, /Esc(?:ape)?[^\n]*cancel/i, "non-editing navigation explains Escape cancellation");
	assert.doesNotMatch(initial, /Esc(?:ape)?[^\n]*(?:keep|preserv)[^\n]*draft/i);
	focusCustomForKeyboard(component, width);
	component.handleInput(ENTER);
	component.handleInput("kept draft");
	component.handleInput(ENTER);
	component.handleInput("second line");

	let lines = renderedText(component, width);
	const direct = optionControlRow(lines, "Direct");
	const staged = optionControlRow(lines, "Staged");
	const draft = lines.findIndex((line) => line.includes("kept draft"));
	const primary = actionRow(lines, "Next");
	assert.ok(draft > Math.max(direct, staged), "an open custom editor remains below authored options");
	assert.ok(draft < primary, "the open editor remains above the primary action");
	assert.match(lines.join("\n"), /Esc(?:ape)?[^\n]*(?:keep|preserv|draft)/i,
		"editing navigation explains that Escape preserves the draft");
	assert.doesNotMatch(lines.join("\n"), /Esc(?:ape)?[^\n]*cancel/i,
		"editing navigation does not falsely describe Escape as cancellation");

	component.handleInput(ESCAPE);
	assert.equal(outcomes.length, 0, "Escape closes editing without cancelling the questionnaire");
	lines = renderedText(component, width);
	assert.match(lines.join("\n"), /kept draft[\s\S]*second line/, "closing editing preserves the multiline draft");
	assert.doesNotMatch(lines.join("\n"), /Custom response/);
	component.handleInput(ENTER);
	assert.match(renderedText(component, width).join("\n"), /kept draft[\s\S]*second line/,
		"reopening Custom answer restores the preserved draft");
});

test("closing custom editing keeps its draft, returns option controls, and cancellation completes once", () => {
	const outcomes: unknown[] = [];
	const component = view((outcome) => outcomes.push(outcome)).component;
	focusCustomForKeyboard(component);
	component.handleInput("draft kept while browsing options");
	component.handleInput(ESCAPE);
	assert.equal(outcomes.length, 0, "closing editing does not finish the questionnaire");
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Direct/);
	clickVisible(component, /Custom/);
	const retainedDraft = component.render(64).map((line) => stripTerminalSequences(line));
	assert.match(retainedDraft.join("\n"), /draft kept while browsing options/, "the complete draft is retained at a sufficient width");
	const narrowDraft = component.render(20).map((line) => stripTerminalSequences(line));
	assert.ok(narrowDraft.every((line) => visibleWidth(line) <= 20));
	assert.ok(narrowDraft.some((line) => line.includes("draft kept")), "the narrow editor exposes the first wrapped draft segment");
	assert.ok(narrowDraft.some((line) => line.includes("browsing options")), "the narrow editor exposes the final wrapped draft segment");
	clickVisible(component, "Cancel");
	component.handleInput("n");
	component.handleInput("s");
	component.cancel();
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: true, answers: [] }]);
});

test("selecting is display-only until Next, then Submit emits reducer-owned frozen metadata once", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	const initial = stripTerminalSequences(component.render(48).join("\n"));
	assert.match(initial, /Question 1[\s\S]*Direct[\s\S]*Staged[\s\S]*Custom answer/);
	assert.match(initial, /exact preview/, "the authored option preview remains visible");
	assert.doesNotMatch(initial, /(?:^|\n)Options(?:\n|$)/, "the old Options tab is absent from the visual chrome");
	component.handleInput("\r");
	component.handleInput("n");
	component.handleInput("s");
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "option", answer: "Direct", preview: "exact preview",
	}] }]);
	component.handleInput("s");
	assert.equal(component.render(48).length, 0, "completion disposes before its callback can reenter");
});

test("custom drafts preserve Editor normalization while note controls are absent", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	assert.doesNotMatch(stripTerminalSequences(component.render(48).join("\n")), /Question note|Global note/, "the TUI exposes no note controls");
	component.handleInput("\r");
	component.handleInput("n");
	component.handleInput("]");
	focusCustomForKeyboard(component);
	component.handleInput("  custom\tline");
	component.handleInput("\r");
	component.handleInput("next  qg");
	component.handleInput("\u001b");
	component.handleInput("n");
	component.handleInput("s");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [
		{ questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "option", answer: "Direct", preview: "exact preview" },
		{ questionIndex: 1, question: "Choose checks", kind: "custom", answer: "  custom    line\nnext  qg" },
	] });
});

test("Escape leaves an editor draft, then cancels committed partials; width and text display stay safe", () => {
	const outcomes: unknown[] = [];
	const { component, renders } = view((outcome) => outcomes.push(outcome));
	assert.equal(component.handleMouse(mouse(32)), undefined, "pointer is inert before a frame");
	const lines = component.render(32);
	assert.ok(lines.every((line) => visibleWidth(line) <= 32));
	assert.equal(component.handleMouse(mouse(31)), undefined, "stale width is rejected");
	assert.doesNotMatch(stripTerminalSequences(lines.join("\n")), /\u001b\[31m/);
	component.handleInput("\r");
	component.handleInput("n");
	focusCustomForKeyboard(component);
	component.handleInput("draft");
	component.handleInput("\u001b");
	component.handleInput("\u001b");
	assert.equal(outcomes.length, 1);
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: true, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "option", answer: "Direct", preview: "exact preview",
	}] });
	assert.ok(renders() > 0);
});

test("preserves a split large bracketed paste except Editor line-ending and tab normalization", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	const raw = `word/~/.path\u000b\u000c\t${"x".repeat(1001)}\r\n${Array.from({ length: 10 }, (_, index) => `line-${index}`).join("\n")}`;
	const expected = raw.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
	focusCustomForKeyboard(component);
	component.handleInput(`\u001b[200~${raw.slice(0, 537)}`);
	component.handleInput(`${raw.slice(537)}\u001b[201~`);
	component.handleInput("\u001b");
	component.handleInput("n");
	component.handleInput("s");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: expected,
	}] });
});

test("mouse question navigation closes and persists the current editor before rebinding", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	focusCustomForKeyboard(component);
	component.handleInput("first");
	const navigationFrame = component.render(48);
	component.handleMouse(mouse(48, 1, navigationFrame.length));
	focusCustomForKeyboard(component);
	component.handleInput("second");
	component.handleInput("\u001b");
	component.handleInput("[");
	focusCustomForKeyboard(component);
	component.handleInput("\u001b");
	component.handleInput("n");
	component.handleInput("]");
	focusCustomForKeyboard(component);
	component.handleInput("\u001b");
	component.handleInput("n");
	component.handleInput("s");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [
		{ questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: "first" },
		{ questionIndex: 1, question: "Choose checks", kind: "custom", answer: "second" },
	] });
});

test("rebuild invalidates same-width pointer geometry, retains focus, and hides retired options", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	component.render(32);
	component.handleInput("\u001b[B");
	component.handleInput("\r");
	assert.equal(component.handleMouse(mouse(32)), undefined, "a same-width old frame is inert after rebuild");
	component.render(32);
	component.handleInput("\r");
	component.handleInput("n");
	component.handleInput("s");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "option", answer: "Staged",
	}] });
	const hidden = view((outcome) => outcomes.push(outcome)).component;
	focusCustomForKeyboard(hidden);
	hidden.handleInput("\u001b");
	hidden.handleInput(SHIFT_TAB);
	hidden.handleInput("s");
	assert.deepEqual(outcomes[1], { correlationId: "view-correlation", cancelled: false, answers: [] });
});

test("public input buffering delivers a complete bracketed paste across every opening-marker split", () => {
	const start = "\u001b[200~";
	for (let boundary = 1; boundary < start.length; boundary++) {
		const buffer = new StdinBuffer();
		const pasted: string[] = [];
		buffer.on("paste", (value) => pasted.push(value));
		buffer.process(start.slice(0, boundary));
		buffer.process(`${start.slice(boundary)}payload\u001b[201~`);
		assert.deepEqual(pasted, ["payload"], `opening marker split at ${boundary}`);
		buffer.destroy();
	}
});

test("active paste owns command-shaped fragments, including split end markers", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	focusCustomForKeyboard(component);
	component.handleInput("\u001b[200~a");
	component.handleInput("\r");
	component.handleInput("bs\u001b");
	component.handleInput("[201~");
	component.handleInput("\u001b");
	component.handleInput("n");
	component.handleInput("s");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: "a\nbs",
	}] });
});

test("unfinished paste persists before mouse header navigation", () => {
	const outcomes: unknown[] = [];
	const navigated = view((outcome) => outcomes.push(outcome)).component;
	focusCustomForKeyboard(navigated);
	navigated.handleInput("\u001b[200~nav");
	navigated.handleInput("\u001b");
	click(navigated, "2. Checks");
	navigated.handleInput("[");
	focusCustomForKeyboard(navigated);
	navigated.handleInput("\u001b");
	navigated.handleInput("n");
	navigated.handleInput("s");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: "nav\u001b",
	}] });
});

test("unfinished paste persists before mouse finalization", () => {
	const outcomes: unknown[] = [];
	const finished = view((outcome) => outcomes.push(outcome)).component;
	focusCustomForKeyboard(finished);
	finished.handleInput("\u001b[200~finish");
	click(finished, "Next");
	click(finished, "Submit");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: "finish",
	}] });
});

test("ordinary Escape remains immediate when no complete public paste has started", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	focusCustomForKeyboard(component);
	component.handleInput("draft");
	component.handleInput("\u001b");
	component.handleInput("\u001b");
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: true, answers: [] }]);
});

test("a 20-column pointer affordance visibly opens inline custom editors for single and multi questions", () => {
	const { component } = view();
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Custom answer/, "the free-answer affordance remains fully visible at 20 columns");
	clickVisible(component, "Custom answer");
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Custom response/, "pointer activation opens the public editor inline for the single-select question");
	component.handleInput("single answer");
	clickVisible(component, "Next");
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Question 2:/, "Next visibly advances after committing the active answer");
	clickVisible(component, "Custom answer");
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Custom response/, "pointer activation opens the public editor inline for the multi-select question");
	component.handleInput("multi answer");
});

test("pointer Next commits each answer and Submit remains explicit on the last question", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	clickVisible(component, /Custom/);
	component.handleInput("first answer");
	clickVisible(component, "Next");
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Question 2:/, "Next visibly advances after committing the active answer");
	clickVisible(component, /Custom/);
	component.handleInput("second answer");
	assert.equal(outcomes.length, 0, "the last question stays pending until explicit Submit");
	clickVisible(component, "Submit");
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: false, answers: [
		{ questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: "first answer" },
		{ questionIndex: 1, question: "Choose checks", kind: "custom", answer: "second answer" },
	] }]);
});

test("Escape closes an active custom editor without losing its draft, including an explicit empty custom answer", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	clickVisible(component, /Custom/);
	component.handleInput("saved draft");
	component.handleInput(ESCAPE);
	assert.doesNotMatch(stripTerminalSequences(component.render(20).join("\n")), /Custom response/, "Escape restores option controls instead of leaving the custom editor open");
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Direct/, "authored options are visible after editing closes");
	clickVisible(component, /Custom/);
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /saved draft/, "switching back preserves the custom draft");

	const empty = view((outcome) => outcomes.push(outcome)).component;
	clickVisible(empty, /Custom/);
	clickVisible(empty, "Next");
	clickVisible(empty, "Submit");
	assert.deepEqual(outcomes[0], { correlationId: "view-correlation", cancelled: false, answers: [{
		questionIndex: 0, question: "Choose \u001b[31ma route\u001b[0m", kind: "custom", answer: "",
	}] });
});

test("Kitty repeat events cannot collapse or cancel the questionnaire accidentally", () => {
	const repeatCollapse = "\u001b[93;5:2u";
	const component = view().component;
	focusCustomForKeyboard(component);
	component.handleInput("private draft");
	component.handleInput(repeatCollapse);
	assert.doesNotMatch(stripTerminalSequences(component.render(48).join("\n")), /to expand · Esc to cancel/);
	component.handleInput("\u001d");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /to expand · Esc to cancel/);
	component.handleInput(repeatCollapse);
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /to expand · Esc to cancel/);

	const outcomes: unknown[] = [];
	const cancelView = view((outcome) => outcomes.push(outcome)).component;
	cancelView.handleInput("\u001b[27;1:2u");
	assert.deepEqual(outcomes, [], "a repeated Escape does not cancel a live questionnaire");
	cancelView.handleInput("\u001b");
	cancelView.handleInput("\u001b[27;1:2u");
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: true, answers: [] }]);
});

test("Ctrl+] collapses a custom draft to only the privacy hint, restores it, and Escape cancels", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	focusCustomForKeyboard(component);
	component.handleInput("private draft");
	component.handleInput("\u001d");

	const collapsed = component.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean);
	assert.deepEqual(collapsed, ["Ctrl+] to expand · Esc to cancel"]);
	assert.equal(outcomes.length, 0, "collapsing never completes the questionnaire");

	component.handleInput("\u001d");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /private draft/, "expanding restores the exact active draft");
	component.handleInput("\u001d");
	component.handleInput("\u001b");
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: true, answers: [] }]);
});

test("collapsed input and stale mouse controls cannot modify or complete a custom draft", async () => {
	const outcomes: unknown[] = [];
	const externalCalls: string[] = [];
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme,
		onDone: (outcome) => outcomes.push(outcome), externalEditor: async (draft) => { externalCalls.push(draft); return draft; },
	});
	const expanded = component.render(48);
	const nextY = expanded.findIndex((line) => stripTerminalSequences(line).includes("Next"));
	assert.ok(nextY >= 0, "the expanded frame has a Next hit target before collapse");
	focusCustomForKeyboard(component);
	component.handleInput("private draft");
	component.handleInput("\u001d");
	assert.equal(component.handleMouse(mouse(48, nextY, expanded.length)), undefined, "retired Next geometry is inert while collapsed");
	component.handleInput("n");
	component.handleInput("s");
	component.handleInput("\t");
	component.handleInput("]");
	component.handleInput("\r");
	component.handleInput("\u0007");
	await Promise.resolve();
	assert.equal(outcomes.length, 0, "collapsed commands never complete the questionnaire");
	assert.deepEqual(externalCalls, [], "collapsed Ctrl+G never launches the external editor");
	component.handleInput("\u001d");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Question 1:[\s\S]*private draft/, "expansion restores the unchanged question and draft");
});

test("active bracketed paste owns Ctrl+] until the paste closes", () => {
	const { component } = view();
	focusCustomForKeyboard(component);
	component.handleInput("\u001b[200~paste\u001d");
	assert.doesNotMatch(stripTerminalSequences(component.render(48).join("\n")), /to expand · Esc to cancel/, "a configured key inside an active paste is editor data");
	component.handleInput("tail\u001b[201~");
	component.handleInput("\u001d");
	assert.deepEqual(component.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean), ["Ctrl+] to expand · Esc to cancel"]);
});

test("collapsed hint is localized and remains one width-safe line", () => {
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {},
		localize: (key, fallback) => key === "chrome.collapsed.hint" ? "{key} erweitern · Esc abbrechen" : fallback,
	});
	component.handleInput("\u001d");
	assert.deepEqual(component.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean), ["Ctrl+] erweitern · Esc abbrechen"]);
	const narrow = component.render(8);
	assert.equal(narrow.length, 1, "collapsed output never leaves stale rows at narrow widths");
	assert.ok(narrow.every((line) => visibleWidth(line) <= 8), "collapsed output is width-safe");
});

test("complete bracketed paste while collapsed cannot change a custom draft", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	focusCustomForKeyboard(component);
	component.handleInput("original");
	component.handleInput("\u001d");
	assert.deepEqual(component.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean), ["Ctrl+] to expand · Esc to cancel"]);
	component.handleInput("\u001b[200~hidden\u001b[201~");
	component.handleInput("\u001d");
	const expanded = stripTerminalSequences(component.render(48).join("\n"));
	assert.match(expanded, /original/);
	assert.doesNotMatch(expanded, /hidden/);
	assert.equal(outcomes.length, 0, "hidden paste never completes the questionnaire");
});

test("Ctrl+] expands immediately instead of buffering unfinished collapsed paste", () => {
	const { component } = view();
	focusCustomForKeyboard(component);
	component.handleInput("original");
	component.handleInput("\u001d");
	assert.deepEqual(component.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean), ["Ctrl+] to expand · Esc to cancel"]);
	component.handleInput("\u001b[200~hidden");
	component.handleInput("\u001d");
	const expanded = stripTerminalSequences(component.render(48).join("\n"));
	assert.doesNotMatch(expanded, /to expand · Esc to cancel/);
	assert.match(expanded, /original/);
	assert.doesNotMatch(expanded, /hidden/);
});

test("Escape cancels once instead of buffering unfinished collapsed paste", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	focusCustomForKeyboard(component);
	component.handleInput("original");
	component.handleInput("\u001d");
	assert.deepEqual(component.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean), ["Ctrl+] to expand · Esc to cancel"]);
	component.handleInput("\u001b[200~hidden");
	component.handleInput("\u001b");
	component.handleInput("\u001b");
	assert.deepEqual(outcomes, [{ correlationId: "view-correlation", cancelled: true, answers: [] }]);
});

test("renders only static questionnaire chrome through an injected localizer", () => {
	let german = true;
	const localize = (key: string, fallback: string) => german ? ({
		"chrome.question.prefix": "Frage {index}:",
		"chrome.tab.custom": "Eigene Antwort",
		"chrome.custom.response": "Eigene Eingabe:",
		"chrome.editor.custom": "Eigene Eingabe (Esc behält Entwurf)",
		"chrome.primary.next": "Weiter",
		"chrome.primary.submit": "Absenden",
		"chrome.cancel": "Abbrechen",
		"chrome.preview.caption": "Vorschau:",
	}[key] ?? fallback) : fallback;
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {}, localize,
	});

	const translated = stripTerminalSequences(component.render(48).join("\n"));
	assert.match(translated, /Frage 1:/);
	assert.match(translated, /Eigene Antwort/);
	assert.match(translated, /Vorschau:\nexact preview/);
	assert.match(translated, /Weiter/);
	assert.match(translated, /Abbrechen/);
	assert.doesNotMatch(translated, /(?:^|\n)Optionen(?:\n|$)/, "the obsolete Options tab is not localized or rendered");
	assert.match(translated, /Route[\s\S]*Choose a route[\s\S]*Direct[\s\S]*Fast[\s\S]*exact preview/, "request content remains byte-preserved");

	focusCustomForKeyboard(component, 48, "Eigene Antwort");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Eigene Eingabe \(Esc behält Entwurf\)/, "the editor label is static chrome");
	component.handleInput("\u001b");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Eigene Eingabe:/, "the persisted custom label is static chrome");
	component.handleInput(SHIFT_TAB);
	component.handleInput(SHIFT_TAB);
	component.handleInput("\r");
	component.handleInput("n");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Frage 2:[\s\S]*Absenden[\s\S]*Abbrechen/, "the last-question primary label is static chrome");

	german = false;
	component.handleInput("\r");
	const rebuilt = stripTerminalSequences(component.render(48).join("\n"));
	assert.match(rebuilt, /Question 2:[\s\S]*Custom answer[\s\S]*Submit[\s\S]*Cancel/);
	assert.doesNotMatch(rebuilt, /(?:^|\n)Options(?:\n|$)/);
});

test("a configured collapse key replaces Ctrl+] and displays its normalized key", () => {
	type FutureCollapseOptions = ConstructorParameters<typeof QuestionnaireTuiPresentation>[0] & { collapseKey?: string };
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {}, collapseKey: "ctrl+k",
	} as FutureCollapseOptions);
	focusCustomForKeyboard(component);
	component.handleInput("private draft");
	component.handleInput("\u001d");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Custom response/, "the old default shortcut stays with the editor when overridden");
	component.handleInput("\u000b");
	assert.deepEqual(component.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean), ["Ctrl+K to expand · Esc to cancel"]);
});

test("an off collapse key leaves Ctrl+] and Ctrl+K to the current editor", () => {
	type FutureCollapseOptions = ConstructorParameters<typeof QuestionnaireTuiPresentation>[0] & { collapseKey?: string };
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {}, collapseKey: "off",
	} as FutureCollapseOptions);
	focusCustomForKeyboard(component);
	component.handleInput("private draft");
	component.handleInput("\u001d");
	component.handleInput("\u000b");
	const expanded = stripTerminalSequences(component.render(48).join("\n"));
	assert.match(expanded, /Custom response/, "disabled collapse never enters hidden state");
	assert.doesNotMatch(expanded, /to expand · Esc to cancel/);
});
