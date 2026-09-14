import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, stripTerminalSequences, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { QuestionnaireTuiPresentation } from "../lib/questions/tui-presentation-view.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

// Markdown delegates styling to the SDK's process-wide theme callbacks.
initTheme("dark");

const SELECTED_BACKGROUND = "\u001b[48;5;24m";
const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `${SELECTED_BACKGROUND}${text}\u001b[49m`,
	bold: (text: string) => text,
};

function request() {
	const result = createFrozenQuestionnaireRequest("viewport-correlation", { questions: [{
		header: "Single route",
		question: "Choose a route after reading this long description that must remain scrollable inside the full-terminal body viewport.",
		options: [
			{ label: "Direct", description: "A long option description that wraps at narrow widths and cannot push the footer away.", preview: "A long preview that must scroll with the option body." },
			{ label: "Staged", description: "A second long description makes the body taller than a short terminal." },
		],
	}, {
		header: "Multiple checks",
		question: "Choose every check that applies after reviewing the long preview body.",
		multiSelect: true,
		options: [
			{ label: "Unit", description: "Fast feedback for the focused behavior.", preview: "Unit preview with enough detail to wrap." },
			{ label: "Integration", description: "Broader coverage for the final outcome.", preview: "Integration preview with enough detail to wrap." },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid fixture");
	return result.request;
}

function simpleRequest() {
	const result = createFrozenQuestionnaireRequest("cancel-correlation", { questions: [{
		header: "Route", question: "Choose a route", options: [
			{ label: "Direct", description: "Fast" }, { label: "Staged", description: "Careful" },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid simple fixture");
	return result.request;
}

function previewFocusRequest(multiSelect?: false) {
	const longPreview = [
		"LONG_PREVIEW_CONTENT begins the longer preview.",
		...Array.from({ length: 8 }, (_, index) => `Long preview detail ${index + 1} remains available.`),
		"LONG_PREVIEW_TAIL",
	].join("\n");
	const question = {
		header: "Preview focus",
		question: "Choose one route.",
		options: [
			{ label: "Short", description: "Brief.", preview: "SHORT_PREVIEW_CONTENT remains in the focused preview area." },
			{ label: "Long preview", description: "Long.", preview: longPreview },
			{ label: "Plain route", description: "None." },
		],
		...(multiSelect === undefined ? {} : { multiSelect }),
	};
	const result = createFrozenQuestionnaireRequest("preview-focus-geometry", { questions: [question] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid preview-focus fixture");
	return result.request;
}

const previewFocusLabels = ["Short", "Long preview", "Plain route"];
const previewFocusOrder = ["Long preview", "Plain route", "Short"];

const CTRL_PAGE_UP = "\u001b[5^";
const CTRL_PAGE_DOWN = "\u001b[6^";

function longPreviewRequest() {
	const preview = [
		"LONG_PREVIEW_CONTENT introduction.",
		...Array.from({ length: 18 }, (_, index) => `Preview detail ${index + 1} remains in the body.`),
		"PREVIEW_TAIL",
	].join("\n");
	const result = createFrozenQuestionnaireRequest("preview-tail-viewport", { questions: [{
		header: "Preview tail",
		question: "Choose the route after reading its preview.",
		multiSelect: false,
		options: [
			{ label: "Long route", description: "A compact route description.", preview },
			{ label: "Plain", description: "None." },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid preview-tail fixture");
	return result.request;
}

function view(rows: number, done: (outcome: unknown) => void = () => {}, fixture = request()) {
	return new QuestionnaireTuiPresentation({
		request: fixture,
		// The fullscreen host supplies the terminal cap; the view derives its effective frame height.
		tui: { terminal: { rows }, requestRender() {} } as TUI,
		theme,
		onDone: done,
	});
}

function event(
	type: TuiMouseEvent["type"], y: number, width: number, height: number,
	button: TuiMouseEvent["button"] = "left", wheelDelta?: number,
): TuiMouseEvent {
	return { type, button, x: 0, y, screenX: 0, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

function frame(component: QuestionnaireTuiPresentation, width: number, rows: number): string[] {
	const lines = component.render(width);
	assert.ok(lines.length <= rows, "the full-width overlay is capped by the actual terminal height");
	return lines;
}

function text(lines: readonly string[]): string[] {
	return lines.map((line) => stripTerminalSequences(line).trim());
}

function rowHasSelectedBackground(lines: readonly string[], label: string): boolean {
	const line = lines.find((value) => stripTerminalSequences(value).includes(label));
	assert.ok(line !== undefined, `layout contains ${label}`);
	return line!.includes(SELECTED_BACKGROUND);
}

function isExactSemanticControlLine(line: string, label: string): boolean {
	const value = line.trim();
	return value === label || value === `→ ${label}` || value === `[${label}]` || value === `→ [${label}]`;
}

function scrollBodyUntil(
	component: QuestionnaireTuiPresentation, width: number, rows: number, label: string, wheelDelta = 1, maxSteps = 320,
): string[] {
	let lines = frame(component, width, rows);
	for (let step = 0; step < maxSteps; step++) {
		if (text(lines).some((line) => isExactSemanticControlLine(line, label))) return lines;
		assert.equal(component.handleMouse(event("wheel", 0, width, lines.length, "none", wheelDelta))?.handled, true,
			`bounded body scrolling remains handled while revealing ${label}`);
		lines = frame(component, width, rows);
	}
	return lines;
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

function actionRow(lines: readonly string[], label: ActionLabel): number {
	let row = -1;
	for (const [index, line] of text(lines).entries()) {
		if (actionButtons(line).some((button) => button.label === label)) row = index;
	}
	assert.ok(row >= 0, `${label} is inside the visible capped frame`);
	return row;
}

function keyboardActionRow(lines: readonly string[], label: ActionLabel): number {
	const row = actionRow(lines, label);
	assert.ok(row >= 0, `${label} is inside the visible keyboard footer`);
	return row;
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

function focusedKeyboardRow(lines: readonly string[], label: string): number {
	const row = text(lines).findIndex((line) => isFocusedControlLine(line, label));
	assert.ok(row >= 0, `${label} has a visible keyboard focus marker`);
	return row;
}

function optionRow(lines: readonly string[], label: string): number {
	const row = text(lines).findIndex((line) => line.includes(label));
	assert.ok(row >= 0, `${label} is inside the visible option body`);
	return row;
}

function hasVisibleMatrixTail(lines: readonly string[]): boolean {
	return text(lines).join(" ").includes("UNIQUE MATRIX TAIL");
}

function eventAt(
	type: TuiMouseEvent["type"], x: number, y: number, width: number, height: number,
	button: TuiMouseEvent["button"] = "left", wheelDelta?: number,
): TuiMouseEvent {
	return { ...event(type, y, width, height, button, wheelDelta), x, screenX: x };
}

function assertStablePreviewGeometry(
	before: readonly string[], after: readonly string[], width: number, labels: readonly string[] = previewFocusLabels,
): void {
	assert.equal(after.length, before.length, `${width}-column preview focus keeps the frame height stable`);
	for (const label of labels) {
		assert.equal(optionRow(after, label), optionRow(before, label), `${width}-column focus keeps ${label} in the same row`);
	}
	assert.equal(actionRow(after, "Submit"), actionRow(before, "Submit"), `${width}-column focus keeps Submit in the same row`);
	assert.equal(actionRow(after, "Cancel"), actionRow(before, "Cancel"), `${width}-column focus keeps Cancel in the same row`);
	assertFooter(after, "Submit");
}

function exercisePreviewFocusCycle(component: QuestionnaireTuiPresentation, width: number, rows: number): string[] {
	let lines = frame(component, width, rows);
	const initial = lines;
	const states = [initial];
	for (const label of previewFocusOrder) {
		const target = optionRow(lines, label);
		assert.equal(clickFrame(component, target, width, lines.length)?.handled, true, `${width}-column ${label} remains pointer-reachable`);
		lines = frame(component, width, rows);
		if (label === "Plain route") {
			assert.doesNotMatch(text(lines).join("\n"), /Preview:|SHORT_PREVIEW_CONTENT|LONG_PREVIEW_CONTENT/, `${width}-column no-preview focus leaves its preview area empty`);
		}
		states.push(lines);
	}
	for (const state of states.slice(1)) assertStablePreviewGeometry(initial, state, width);
	return lines;
}

function assertFooter(lines: readonly string[], primary: "Next" | "Submit") {
	const footerRows = text(lines).map(actionButtons).filter((buttons) => buttons.length > 0);
	assert.equal(footerRows.length, 1, "primary and Cancel share one physical footer row");
	const footer = footerRows[0]!;
	assert.equal(footer.filter((button) => button.label === primary).length, 1, "the footer has exactly one primary action");
	const opposite = primary === "Next" ? "Submit" : "Next";
	assert.equal(footer.filter((button) => button.label === opposite).length, 0, "the opposite primary action is absent");
	assert.equal(footer.filter((button) => button.label === "Cancel").length, 1, "the footer has exactly one Cancel action");
}

for (const width of [20, 32]) {
	for (const rows of [10, 16, 24]) {
		test(`full-width overlay caps within the actual ${width}x${rows} terminal frame`, () => {
			const component = view(rows);
			const lines = frame(component, width, rows);
			assertFooter(lines, "Next");
			assert.ok(actionRow(lines, "Next") < lines.length, "Next is pointer-reachable inside the capped frame");
		});
	}
}

test("fresh pointer press/click advances an explicit first answer, then Submit finalizes only the last question", () => {
	const outcomes: unknown[] = [];
	const width = 32;
	const rows = 24;
	const component = view(rows, (outcome) => outcomes.push(outcome));

	let lines = scrollBodyUntil(component, width, rows, "Custom answer");
	const custom = text(lines).findIndex((line) => isExactSemanticControlLine(line, "Custom answer"));
	assert.ok(custom >= 0, "the free-answer control is pointer-reachable in the visible body");
	component.handleMouse(event("press", custom, width, lines.length));
	component.handleMouse(event("click", custom, width, lines.length));
	component.handleInput("first answer");

	lines = frame(component, width, rows);
	const next = actionRow(lines, "Next");
	component.handleMouse(event("press", next, width, lines.length));
	component.handleMouse(event("click", next, width, lines.length));
	assert.equal(outcomes.length, 0, "Next commits and advances without auto-submitting");
	assert.match(stripTerminalSequences(frame(component, width, rows).join("\n")), /Question 2:/);

	lines = frame(component, width, rows);
	assertFooter(lines, "Submit");
	const unit = text(lines).findIndex((line) => line.includes("Unit"));
	assert.ok(unit >= 0, "the multi-select body remains pointer-reachable");
	component.handleMouse(event("press", unit, width, lines.length));
	component.handleMouse(event("click", unit, width, lines.length));
	lines = frame(component, width, rows);
	const submit = actionRow(lines, "Submit");
	component.handleMouse(event("press", submit, width, lines.length));
	component.handleMouse(event("click", submit, width, lines.length));
	assert.equal(outcomes.length, 1, "Submit finalizes only after the explicit last-question answer");
});

test("cross-question rebuild keeps focus owned by the new question", () => {
	const component = view(24, () => {}, request());
	component.handleInput("\u001b[B");
	component.handleInput("\r");
	component.handleInput("n");
	const lines = frame(component, 32, 24);
	assert.match(text(lines).join("\n"), /Choose\s+every\s+check\s+that\s+applies\s+after\s+reviewing\s+the\s+long\s+preview\s+body\./);
	assert.ok(focusedKeyboardRow(lines, "Unit") < keyboardActionRow(lines, "Submit"),
		"advancing after focusing the prior question's second option starts the new question at Unit");
	assert.equal(text(lines).some((line) => isFocusedControlLine(line, "Integration")), false,
		"the prior question's focused option is not reused by the new question");
});

test("option and footer hover use the host theme background and reset on the inert footer gap", () => {
	const width = 32;
	const rows = 24;
	const component = view(rows);
	const before = frame(component, width, rows);
	const option = text(before).findIndex((line) => line.includes("Staged"));
	assert.ok(option >= 0 && option < before.length, "a non-focused option is visible in the capped body frame");
	component.handleMouse(event("move", option, width, before.length, "none"));
	const hovered = frame(component, width, rows);
	assert.equal(rowHasSelectedBackground(hovered, "Staged"), true, "the independently hovered row uses the selected background token");
	assert.equal(rowHasSelectedBackground(hovered, "Direct"), rowHasSelectedBackground(before, "Direct"),
		"hovering a non-focused row preserves the focused row baseline");
	const gap = actionRow(before, "Next") - 1;
	assert.equal(text(before)[gap], "", "the footer is preceded by one inert gap");
	component.handleMouse(event("move", gap, width, before.length, "none"));
	const reset = frame(component, width, rows);
	assert.equal(rowHasSelectedBackground(reset, "Staged"), rowHasSelectedBackground(before, "Staged"),
		"moving onto the gap restores the non-focused option baseline");
	assert.equal(rowHasSelectedBackground(reset, "Direct"), rowHasSelectedBackground(before, "Direct"),
		"moving onto the gap preserves the focused option baseline");

	const current = frame(component, width, rows);
	const next = actionRow(current, "Next");
	assert.ok(next < current.length, "the footer action is inside the capped frame before hover");
	component.handleMouse(event("move", next, width, current.length, "none"));
	const footerHovered = frame(component, width, rows);
	assert.equal(footerHovered[next]!.includes(SELECTED_BACKGROUND), true, "action hover applies the same theme background to its own row");
});

test("wheel scrolls the long body while the sticky footer remains inside the terminal frame", () => {
	const width = 20;
	const rows = 16;
	const component = view(rows);
	const before = frame(component, width, rows);
	assertFooter(before, "Next");
	const result = component.handleMouse(event("wheel", 4, width, before.length, "none", 1));
	assert.equal(result?.handled, true, "wheel is handled by the questionnaire body scroll view");
	const after = frame(component, width, rows);
	assert.notDeepEqual(after, before, "wheel changes the body without hiding the footer");
	assertFooter(after, "Next");
});

test("keyboard focus scrolls Custom answer into the visible body while the sticky footer stays fixed", () => {
	for (const { width, rows } of [{ width: 20, rows: 10 }, { width: 80, rows: 16 }]) {
		const outcomes: unknown[] = [];
		const component = view(rows, (outcome) => outcomes.push(outcome));
		let lines = frame(component, width, rows);
		const initialFooter = keyboardActionRow(lines, "Next");

		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		lines = frame(component, width, rows);
		const custom = focusedKeyboardRow(lines, "Custom answer");
		assert.ok(custom < keyboardActionRow(lines, "Next"), `${width}x${rows} Custom answer is visible in the body, not the footer`);
		assert.equal(keyboardActionRow(lines, "Next"), initialFooter, `${width}x${rows} focus scrolling does not move the sticky Next footer`);
		assert.equal(lines.length, frame(component, width, rows).length, `${width}x${rows} focus scrolling preserves the frame height`);
		assert.equal(outcomes.length, 0, `${width}x${rows} focus movement does not complete the questionnaire`);

		component.handleInput("\r");
		component.handleInput("\t");
		lines = frame(component, width, rows);
		const nextFooter = keyboardActionRow(lines, "Next");
		assert.equal(focusedKeyboardRow(lines, "Next"), nextFooter, `${width}x${rows} Next is keyboard-reachable in the sticky footer`);
		component.handleInput("\r");
		lines = frame(component, width, rows);
		const secondQuestion = text(lines).join("\n");
		assert.match(secondQuestion, /every check that/, `${width}x${rows} keyboard Next exposes the second question text`);
		assert.ok(focusedKeyboardRow(lines, "Unit") < keyboardActionRow(lines, "Submit"),
			`${width}x${rows} keyboard Next advances to the second question's Unit option`);
		assert.equal(outcomes.length, 0);

		const secondFooter = keyboardActionRow(lines, "Submit");
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		component.handleInput("\u001b[B");
		lines = frame(component, width, rows);
		assert.equal(focusedKeyboardRow(lines, "Submit"), secondFooter, `${width}x${rows} Submit is keyboard-reachable after the body scroll`);
		assert.equal(keyboardActionRow(lines, "Submit"), secondFooter, `${width}x${rows} Submit stays in the sticky footer`);
		component.handleInput("\u001b[B");
		lines = frame(component, width, rows);
		assert.equal(focusedKeyboardRow(lines, "Cancel"), secondFooter, `${width}x${rows} Cancel shares the physical footer row with Submit`);
		assert.equal(keyboardActionRow(lines, "Submit"), secondFooter, `${width}x${rows} Cancel focus does not move the sticky footer`);
		assert.equal(outcomes.length, 0, `${width}x${rows} reaching footer actions does not auto-submit or cancel`);
	}
});

test("body wheel scrolling preserves its manual position until keyboard focus moves", () => {
	const width = 20;
	const rows = 10;
	const component = view(rows, () => {}, matrixRequest());
	let lines = frame(component, width, rows);
	const initialFooter = keyboardActionRow(lines, "Submit");

	for (let index = 0; index < 4; index++) component.handleInput("\u001b[B");
	lines = frame(component, width, rows);
	const custom = focusedKeyboardRow(lines, "Custom answer");
	assert.ok(custom < initialFooter, "the focused Custom answer control is in the scrollable body");

	let scrolledAway = false;
	let reachedTail = hasVisibleMatrixTail(lines);
	const maxBodyWheelSteps = 320;
	for (let index = 0; index < maxBodyWheelSteps && (!scrolledAway || !reachedTail); index++) {
		const currentCustom = text(lines).findIndex((line) => isFocusedControlLine(line, "Custom answer"));
		const wheelRow = currentCustom >= 0 ? currentCustom : 0;
		if (currentCustom < 0) scrolledAway = true;
		assert.equal(component.handleMouse(event("wheel", wheelRow, width, lines.length, "none", -1))?.handled, true,
			"a wheel at the body stays body-owned instead of being treated as preview input");
		lines = frame(component, width, rows);
		scrolledAway = scrolledAway || !text(lines).some((line) => isFocusedControlLine(line, "Custom answer"));
		reachedTail = hasVisibleMatrixTail(lines);
	}
	assert.equal(scrolledAway, true, "manual body scrolling may move the focused control out of view");
	assert.equal(reachedTail, true, "manual body scrolling reaches the unique wrapped matrix tail marker");
	assert.equal(keyboardActionRow(lines, "Submit"), initialFooter, "manual body scrolling leaves the sticky footer fixed");
	const manuallyScrolled = lines;
	assert.deepEqual(frame(component, width, rows), manuallyScrolled, "an ordinary rerender preserves manual body scrolling");

	component.handleInput("\u001b[A");
	lines = frame(component, width, rows);
	assert.ok(focusedKeyboardRow(lines, "Row 4") < keyboardActionRow(lines, "Submit"),
		"keyboard navigation restores a body focus marker after manual scrolling");
	assert.equal(keyboardActionRow(lines, "Submit"), initialFooter, "keyboard focus restoration leaves the sticky footer fixed");
});

for (const rows of [1, 2, 3]) {
	test(`a ${rows}-row overlay keeps pointer Cancel when its label physically fits`, () => {
		const outcomes: unknown[] = [];
		const width = 20;
		const component = view(rows, (outcome) => outcomes.push(outcome), simpleRequest());
		const lines = frame(component, width, rows);
		const cancel = actionRow(lines, "Cancel");
		component.handleMouse(event("press", cancel, width, lines.length));
		component.handleMouse(event("click", cancel, width, lines.length));
		assert.equal(outcomes.length, 1, "the minimal frame does not require a keyboard shortcut to cancel");
	});
}

test("primary and Cancel share one bottom row with distinct pointer bounds at narrow widths and after resize", () => {
	for (const width of [20, 32]) {
		const host = { terminal: { rows: 24 }, requestRender() {} };
		const outcomes: unknown[] = [];
		const component = new QuestionnaireTuiPresentation({ request: simpleRequest(), tui: host as TUI, theme, onDone: (outcome) => outcomes.push(outcome) });
		let lines = frame(component, width, host.terminal.rows);
		for (const rows of [24, 8]) {
			host.terminal.rows = rows;
			lines = frame(component, width, rows);
			assertFooter(lines, "Submit");
			const submit = actionRow(lines, "Submit");
			const cancel = actionRow(lines, "Cancel");
			assert.equal(submit, cancel, `${width}x${rows} primary and Cancel share one physical row`);
			assert.equal(submit, lines.length - 1, `${width}x${rows} footer stays anchored to the bottom`);
			const footer = stripTerminalSequences(lines[submit]!);
			const submitX = footer.indexOf("Submit");
			const cancelX = footer.indexOf("Cancel");
			assert.ok(submitX >= 0 && cancelX > submitX + "Submit".length, `${width}x${rows} actions retain a clickable gap`);
		}

		const submit = actionRow(lines, "Submit");
		const footer = stripTerminalSequences(lines[submit]!);
		const submitX = footer.indexOf("Submit");
		const cancelX = footer.indexOf("Cancel");
		const submitEnd = submitX + "Submit".length;
		let gapX = -1;
		for (let x = cancelX - 1; x >= submitEnd; x--) {
			if (/\s/.test(footer[x]!)) {
				gapX = x;
				break;
			}
		}
		assert.ok(gapX > submitEnd && gapX < cancelX, `${width}-column gap is visibly outside both action labels`);
		component.handleMouse(eventAt("press", gapX, submit, width, lines.length));
		component.handleMouse(eventAt("click", gapX, submit, width, lines.length));
		assert.equal(outcomes.length, 0, `${width}-column gap is not part of either action bound`);
		assert.deepEqual(frame(component, width, host.terminal.rows), lines,
			`${width}-column gap click leaves the presentation state unchanged`);
		const verticalGap = submit - 1;
		if (verticalGap >= 0 && text(lines)[verticalGap] === "") {
			component.handleMouse(eventAt("press", 0, verticalGap, width, lines.length));
			component.handleMouse(eventAt("click", 0, verticalGap, width, lines.length));
			assert.equal(outcomes.length, 0, `${width}-column vertical gap cannot activate a footer action`);
			assert.deepEqual(frame(component, width, host.terminal.rows), lines,
				`${width}-column vertical gap leaves the presentation state unchanged`);
		}
		if (width === 32 && width > cancelX + "Cancel".length) {
			const unused = width - 1;
			component.handleMouse(eventAt("press", unused, submit, width, lines.length));
			component.handleMouse(eventAt("click", unused, submit, width, lines.length));
			assert.equal(outcomes.length, 0, "right-side unused space cannot activate a footer action");
			assert.deepEqual(frame(component, width, host.terminal.rows), lines,
				"right-side unused space leaves the presentation state unchanged");
		}
		component.handleMouse(eventAt("press", submitX + 2, submit, width, lines.length));
		component.handleMouse(eventAt("click", submitX + 2, submit, width, lines.length));
		assert.deepEqual(outcomes, [{ correlationId: "cancel-correlation", cancelled: false, answers: [] }],
			`${width}-column primary label remains clickable at its own bound`);

		const cancelled: unknown[] = [];
		const cancelView = new QuestionnaireTuiPresentation({ request: simpleRequest(), tui: host as TUI, theme, onDone: (outcome) => cancelled.push(outcome) });
		const cancelLines = frame(cancelView, width, host.terminal.rows);
		const cancelRow = actionRow(cancelLines, "Cancel");
		const cancelXAtCurrentWidth = stripTerminalSequences(cancelLines[cancelRow]!).indexOf("Cancel");
		cancelView.handleMouse(eventAt("press", cancelXAtCurrentWidth + 2, cancelRow, width, cancelLines.length));
		cancelView.handleMouse(eventAt("click", cancelXAtCurrentWidth + 2, cancelRow, width, cancelLines.length));
		assert.deepEqual(cancelled, [{ correlationId: "cancel-correlation", cancelled: true, answers: [] }],
			`${width}-column Cancel remains clickable at its own bound`);
	}
});

test("manual body scroll can browse out of a focused Editor and typing reveals its cursor marker again", () => {
	const width = 32;
	const host = { terminal: { rows: 16 }, requestRender() {} };
	const component = new QuestionnaireTuiPresentation({ request: simpleRequest(), tui: host as TUI, theme, onDone() {} });
	component.focused = true;
	let lines = frame(component, width, host.terminal.rows);
	const custom = text(lines).findIndex((line) => line === "Custom answer");
	assert.ok(custom >= 0, "the focused custom-answer control is visible before editing");
	component.handleMouse(event("press", custom, width, lines.length));
	component.handleMouse(event("click", custom, width, lines.length));
	assert.ok(frame(component, width, host.terminal.rows).join("\n").includes(CURSOR_MARKER), "the real focused Editor marker is rendered when it fits");
	component.handleInput("normal input");
	component.handleInput(`\u001b[200~${Array.from({ length: 40 }, (_, row) => `pasted row ${row}`).join("\n")}\u001b[201~`);
	host.terminal.rows = 10;
	assert.equal(component.handleMouse(event("move", 0, width, lines.length, "none")), undefined, "a terminal resize invalidates the old effective frame");
	lines = frame(component, width, host.terminal.rows);
	assert.ok(lines.join("\n").includes(CURSOR_MARKER), "long paste and resize initially reveal the public Editor marker");
	for (let index = 0; index < 12; index++) component.handleMouse(event("wheel", 2, width, lines.length, "none", -1));
	component.handleInput("\u001b");
	lines = frame(component, width, host.terminal.rows);
	const direct = text(lines).findIndex((line) => line.includes("Direct"));
	assert.ok(direct >= 0, "Escape closes editing and restores authored options after manual body scrolling");
	lines = scrollBodyUntil(component, width, host.terminal.rows, "Custom answer");
	const reopen = text(lines).findIndex((line) => isExactSemanticControlLine(line, "Custom answer"));
	assert.ok(reopen >= 0, "bounded body scrolling reveals the custom draft control to reopen");
	component.handleMouse(event("press", reopen, width, lines.length));
	component.handleMouse(event("click", reopen, width, lines.length));
	component.handleInput("typing again");
	assert.ok(frame(component, width, host.terminal.rows).join("\n").includes(CURSOR_MARKER), "typing after manual browsing reveals the public Editor marker again");
});

function compactRequest() {
	const result = createFrozenQuestionnaireRequest("compact-layout", { questions: [{
		header: "Route", question: "Choose a route", options: [{ label: "Direct", description: "Fast" }, { label: "Staged", description: "Careful" }],
	}, {
		header: "Check", question: "Choose a check", options: [{ label: "Unit", description: "Fast" }, { label: "Integration", description: "Broad" }],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid compact fixture");
	return result.request;
}

function matrixRequest() {
	const result = createFrozenQuestionnaireRequest("matrix-layout", { questions: [{
		header: "Matrix", question: "Choose a matrix row with descriptions that wrap at narrow widths.", multiSelect: true,
		options: Array.from({ length: 4 }, (_, index) => ({
			label: `Row ${index + 1}`,
			description: `Description ${index + 1} remains deliberately long enough to require many narrow terminal rows. `.repeat(10) +
					(index === 3 ? " UNIQUE MATRIX TAIL" : ""),
		})),
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("valid matrix fixture");
	return result.request;
}

function compactFrame(component: QuestionnaireTuiPresentation, width: number, rows: number): string[] {
	const lines = component.render(width);
	assert.ok(lines.length <= rows, "the rendered frame never exceeds the available terminal rows");
	return lines;
}

function clickFrame(component: QuestionnaireTuiPresentation, y: number, width: number, height: number) {
	component.handleMouse(event("press", y, width, height));
	return component.handleMouse(event("click", y, width, height));
}

for (const width of [20, 32]) {
	for (const rows of [24, 60]) {
		test(`short ${width}-column questionnaire derives a compact frame within ${rows} rows`, () => {
			const lines = compactFrame(view(rows, () => {}, compactRequest()), width, rows);
			const visible = text(lines);
			assert.ok(lines.length < rows, "short content does not pad to the terminal height");
			assert.doesNotMatch(visible.join("\n"), /Question note|Global note/, "notes have no TUI control");
			const next = actionRow(lines, "Next");
			assert.equal(visible[next - 1], "", "exactly one gap separates body content from the footer");
			assert.notEqual(visible[next - 2], "", "the footer gap is not terminal padding");
		});
	}
}

test("render-derived pointer heights activate compact Next, Submit, and Cancel while the footer gap is inert", () => {
	const outcomes: unknown[] = [];
	const width = 32;
	const component = view(60, (outcome) => outcomes.push(outcome), compactRequest());
	let lines = compactFrame(component, width, 60);
	assert.ok(lines.length < 60, "the pointer frame uses the compact effective height");
	const custom = text(lines).findIndex((line) => line === "Custom answer");
	assert.ok(custom >= 0, "the compact body exposes custom answers");
	assert.equal(clickFrame(component, custom, width, lines.length)?.handled, true, "a render-derived height reaches Custom answer");
	component.handleInput("first answer");
	lines = compactFrame(component, width, 60);
	const next = actionRow(lines, "Next");
	assert.equal(clickFrame(component, next - 1, width, lines.length)?.handled, true, "the footer gap consumes clicks without routing to hidden controls");
	assert.equal(outcomes.length, 0, "a gap click is inert");
	assert.equal(clickFrame(component, next, width, lines.length)?.handled, true, "a render-derived height reaches Next");
	lines = compactFrame(component, width, 60);
	const unit = text(lines).findIndex((line) => line.includes("Unit"));
	assert.ok(unit >= 0, "Next advances to the second question");
	clickFrame(component, unit, width, lines.length);
	lines = compactFrame(component, width, 60);
	const submit = actionRow(lines, "Submit");
	assert.equal(clickFrame(component, submit, width, lines.length)?.handled, true, "a render-derived height reaches Submit");
	assert.equal(outcomes.length, 1, "Submit completes the compact questionnaire");

	const cancelled: unknown[] = [];
	const cancelView = view(60, (outcome) => cancelled.push(outcome), simpleRequest());
	lines = compactFrame(cancelView, width, 60);
	const cancel = actionRow(lines, "Cancel");
	assert.equal(clickFrame(cancelView, cancel, width, lines.length)?.handled, true, "a render-derived height reaches Cancel");
	assert.equal(cancelled.length, 1, "Cancel remains pointer-reachable in a compact frame");
});

test("long matrix content caps, scrolls, resizes, and retains its sticky footer", () => {
	const width = 20;
	const host = { terminal: { rows: 24 }, requestRender() {} };
	const component = new QuestionnaireTuiPresentation({ request: matrixRequest(), tui: host as TUI, theme, onDone() {} });
	const short = compactFrame(component, width, host.terminal.rows);
	assert.equal(short.length, host.terminal.rows, "overflow caps at the short terminal height");
	assertFooter(short, "Submit");
	assert.equal(component.handleMouse(event("wheel", 4, width, short.length, "none", 1))?.handled, true, "the capped matrix body scrolls");
	assert.notDeepEqual(compactFrame(component, width, host.terminal.rows), short, "scrolling changes only the visible matrix body");
	host.terminal.rows = 60;
	const resized = compactFrame(component, width, host.terminal.rows);
	assert.equal(resized.length, host.terminal.rows, "overflow remains capped after a taller resize");
	assertFooter(resized, "Submit");
});

test("single-select preview focus keeps option and footer geometry stable across roomy viewport widths", () => {
	for (const width of [20, 63, 64, 80]) {
		const rows = 60;
		const component = view(rows, () => {}, previewFocusRequest(false));
		const initial = frame(component, width, rows);
		assert.ok(initial.length < rows, `${width}-column fixture exposes its natural height in a roomy terminal`);
		assertFooter(initial, "Submit");
		exercisePreviewFocusCycle(component, width, rows);
	}
});

test("short preview-focus frames keep the footer reachable while focus changes", () => {
	for (const width of [20, 63, 64, 80]) {
		const rows = 16;
		const outcomes: unknown[] = [];
		const component = view(rows, (outcome) => outcomes.push(outcome), previewFocusRequest(false));
		const final = exercisePreviewFocusCycle(component, width, rows);
		const submit = actionRow(final, "Submit");
		assert.equal(clickFrame(component, submit, width, final.length)?.handled, true, `${width}-column Submit remains pointer-reachable after focus`);
		assert.equal(outcomes.length, 1, `${width}-column Submit completes the focused questionnaire`);
	}
});

test("omitted multiSelect does not retain inline previews after focusing a no-preview option", () => {
	const width = 80;
	const rows = 60;
	const component = view(rows, () => {}, previewFocusRequest());
	const withPreview = frame(component, width, rows);
	assert.match(text(withPreview).join("\n"), /SHORT_PREVIEW_CONTENT/, "the focused preview is initially rendered");
	const plain = optionRow(withPreview, "Plain route");
	assert.equal(clickFrame(component, plain, width, withPreview.length)?.handled, true, "the no-preview option can be focused");
	const withoutPreview = frame(component, width, rows);
	const visible = text(withoutPreview).join("\n");
	assert.doesNotMatch(visible, /Preview:|SHORT_PREVIEW_CONTENT|LONG_PREVIEW_CONTENT/, "omitted single-select mode does not retain inline preview content");
});

test("a long focused preview keeps its tail reachable in a short viewport", () => {
	const width = 80;
	const rows = 10;
	const component = view(rows, () => {}, longPreviewRequest());
	let lines = frame(component, width, rows);
	const previewRow = text(lines).findIndex((line) => line.includes("LONG_PREVIEW_CONTENT"));
	assert.ok(previewRow >= 0 && previewRow < actionRow(lines, "Submit"), "the initial frame exposes a visible preview region for wheel input");
	const previewX = stripTerminalSequences(lines[previewRow] ?? "").indexOf("LONG_PREVIEW_CONTENT");
	assert.ok(previewX >= 0 && previewX < width, "the visible preview marker provides the wheel input column");
	assert.doesNotMatch(text(lines).join("\n"), /PREVIEW_TAIL/, "the long preview tail starts below the visible viewport");
	let reachedTail = false;
	for (let index = 0; index < 120 && !reachedTail; index++) {
		assert.equal(component.handleMouse(eventAt("wheel", previewX, previewRow, width, lines.length, "none", 1))?.handled, true, "wheel over the visible preview region is handled");
		lines = frame(component, width, rows);
		reachedTail = text(lines).some((line) => line.includes("PREVIEW_TAIL"));
	}
	assert.equal(reachedTail, true, "scrolling the preview viewport eventually reveals the long preview tail");
	assertFooter(lines, "Submit");
});

test("preview scrolling rejects stale pointer geometry after the terminal height changes", () => {
	const width = 80;
	const host = { terminal: { rows: 10 }, requestRender() {} };
	const component = new QuestionnaireTuiPresentation({ request: longPreviewRequest(), tui: host as TUI, theme, onDone() {} });
	const lines = frame(component, width, host.terminal.rows);
	const previewRow = text(lines).findIndex((line) => line.includes("LONG_PREVIEW_CONTENT"));
	assert.ok(previewRow >= 0 && previewRow < actionRow(lines, "Submit"), "the preview marker is visible before resizing");
	const previewX = stripTerminalSequences(lines[previewRow] ?? "").indexOf("LONG_PREVIEW_CONTENT");
	assert.ok(previewX >= 0 && previewX < width, "the preview marker provides a valid pointer column");
	assert.equal(component.handleMouse(eventAt("wheel", previewX, previewRow, width, lines.length, "none", 1))?.handled, true, "the visible preview region accepts wheel input");
	frame(component, width, host.terminal.rows);

	host.terminal.rows = 16;
	assert.equal(component.handleMouse(eventAt("wheel", previewX, previewRow, width, lines.length, "none", 1)), undefined, "the old height makes preview pointer input stale");
	const resizedWidth = 64;
	const resized = frame(component, resizedWidth, host.terminal.rows);
	assert.ok(resized.length > lines.length, "the taller terminal recomputes a larger but bounded preview slot");
	assert.ok(resized.length <= host.terminal.rows, "the recomputed preview slot remains terminal-bounded");
	assertFooter(resized, "Submit");
	const resizedPreviewRow = text(resized).findIndex((line) => line.includes("LONG_PREVIEW_CONTENT"));
	assert.ok(resizedPreviewRow >= 0 && resizedPreviewRow < actionRow(resized, "Submit"), "the resized frame exposes the preview marker");
	const resizedPreviewX = stripTerminalSequences(resized[resizedPreviewRow] ?? "").indexOf("LONG_PREVIEW_CONTENT");
	assert.ok(resizedPreviewX >= 0 && resizedPreviewX < resizedWidth, "the resized preview marker provides a current pointer column");
	assert.equal(component.handleMouse(eventAt("wheel", resizedPreviewX, resizedPreviewRow, resizedWidth, resized.length, "none", 1))?.handled, true, "current resized preview coordinates remain routable");
	assert.equal(frame(component, resizedWidth, host.terminal.rows).length, resized.length, "inner preview scrolling does not change reserved geometry");
});

test("keyboard preview paging reaches and returns from the tail without questionnaire actions", () => {
	const width = 80;
	const rows = 60;
	const outcomes: unknown[] = [];
	const component = view(rows, (outcome) => outcomes.push(outcome), longPreviewRequest());
	let lines = frame(component, width, rows);
	const focusedOption = text(lines).find((line) => isFocusedControlLine(line, "Long route"));
	assert.ok(focusedOption !== undefined, "the exact long-preview option row starts focused");
	const focusedOptionPrefix = focusedOption.split(" │ ")[0]?.trim();
	assert.equal(focusedOptionPrefix, "→ ( ) Long route", "the long-preview option starts focused and unselected");
	assert.match(text(lines).join("\n"), /Ctrl\+PgUp\/PgDn/, "overflow exposes a keyboard scrolling hint");
	assert.doesNotMatch(text(lines).join("\n"), /PREVIEW_TAIL/, "the long-preview tail starts below the fixed slot");

	let reachedTail = false;
	for (let index = 0; index < 20 && !reachedTail; index++) {
		component.handleInput(CTRL_PAGE_DOWN);
		lines = frame(component, width, rows);
		reachedTail = text(lines).some((line) => line.includes("PREVIEW_TAIL"));
	}
	assert.equal(reachedTail, true, "Ctrl+PgDn reaches the preview tail");
	assert.equal(outcomes.length, 0, "preview paging does not submit or cancel the questionnaire");
	assert.equal(text(lines).find((line) => isFocusedControlLine(line, "Long route"))?.split(" │ ")[0]?.trim(), focusedOptionPrefix, "preview paging does not change option focus or selection");

	let returnedToTop = false;
	for (let index = 0; index < 20 && !returnedToTop; index++) {
		component.handleInput(CTRL_PAGE_UP);
		lines = frame(component, width, rows);
		returnedToTop = text(lines).some((line) => line.includes("LONG_PREVIEW_CONTENT"));
	}
	assert.equal(returnedToTop, true, "Ctrl+PgUp returns to the preview top");
	assert.equal(outcomes.length, 0, "returning through the preview does not submit or cancel the questionnaire");
	assert.equal(text(lines).find((line) => isFocusedControlLine(line, "Long route"))?.split(" │ ")[0]?.trim(), focusedOptionPrefix, "returning through the preview preserves option focus or selection");
});
