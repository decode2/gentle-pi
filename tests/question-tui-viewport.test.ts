import assert from "node:assert/strict";
import test from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { QuestionnaireTuiPresentation } from "../lib/questions/tui-presentation-view.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => `\u001b[48;5;24m${text}\u001b[49m`,
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

function actionRow(lines: readonly string[], label: "Next" | "Submit" | "Cancel"): number {
	const row = text(lines).findIndex((line) => line === label);
	assert.ok(row >= 0, `${label} is inside the visible capped frame`);
	return row;
}

function assertFooter(lines: readonly string[], primary: "Next" | "Submit") {
	const labels = text(lines).filter((line) => line === "Next" || line === "Submit" || line === "Cancel");
	assert.equal(labels.filter((label) => label === primary).length, 1, "the footer has exactly one primary action");
	const opposite = primary === "Next" ? "Submit" : "Next";
	assert.equal(labels.filter((label) => label === opposite).length, 0, "the opposite primary action is absent");
	assert.ok(labels.includes("Cancel"), "Cancel remains inside the visible footer");
	assert.ok(labels.every((label) => !/^\[/.test(label)), "pointer controls do not require keyboard-shortcut labels");
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

	let lines = frame(component, width, rows);
	const custom = text(lines).findIndex((line) => line === "Custom answer");
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

test("option and footer hover use the host theme background and reset on the inert footer gap", () => {
	const width = 32;
	const rows = 24;
	const component = view(rows);
	const before = frame(component, width, rows);
	const option = text(before).findIndex((line) => line.includes("Direct"));
	assert.ok(option >= 0 && option < before.length, "an option is visible in the capped body frame");
	component.handleMouse(event("move", option, width, before.length, "none"));
	assert.match(component.render(width).join("\n"), /\u001b\[48;5;24m/, "option hover applies the selected background token");
	const gap = actionRow(before, "Next") - 1;
	assert.equal(text(before)[gap], "", "the footer is preceded by one inert gap");
	component.handleMouse(event("move", gap, width, before.length, "none"));
	assert.doesNotMatch(component.render(width).join("\n"), /\u001b\[48;5;24m/, "moving onto the gap restores the unhovered option background");

	const current = frame(component, width, rows);
	const next = actionRow(current, "Next");
	assert.ok(next < current.length, "the footer action is inside the capped frame before hover");
	component.handleMouse(event("move", next, width, current.length, "none"));
	assert.match(component.render(width).join("\n"), /\u001b\[48;5;24m/, "action hover applies the same theme background");
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

test("the single footer gap cannot activate a footer action", () => {
	const outcomes: unknown[] = [];
	const width = 32;
	const rows = 24;
	const component = view(rows, (outcome) => outcomes.push(outcome), simpleRequest());
	const before = frame(component, width, rows);
	const submit = actionRow(before, "Submit");
	const gap = submit - 1;
	assert.equal(text(before)[gap], "", "short content has exactly one blank gap above the visible footer");
	component.handleMouse(event("press", gap, width, before.length));
	component.handleMouse(event("click", gap, width, before.length));
	assert.equal(outcomes.length, 0, "the footer gap cannot submit or cancel through an invisible document row");
	assert.deepEqual(frame(component, width, rows), before, "the inert gap leaves the visible presentation state unchanged");
	component.handleMouse(event("press", submit, width, before.length));
	component.handleMouse(event("click", submit, width, before.length));
	assert.equal(outcomes.length, 1, "the actually visible footer action remains pointer-reachable");
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
	lines = frame(component, width, host.terminal.rows);
	const options = text(lines).findIndex((line) => line === "Options");
	assert.ok(options >= 0, "manual body scroll reaches Options without Escape or keyboard navigation");
	component.handleMouse(event("press", options, width, lines.length));
	component.handleMouse(event("click", options, width, lines.length));
	lines = frame(component, width, host.terminal.rows);
	const reopen = text(lines).findIndex((line) => line === "Custom answer");
	assert.ok(reopen >= 0, "pointer Options closes the editor while keeping its custom draft available to reopen");
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
			description: `Description ${index + 1} remains deliberately long enough to require many narrow terminal rows. `.repeat(10),
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
