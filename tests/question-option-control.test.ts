import assert from "node:assert/strict";
import test from "node:test";
import {
	KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS,
	type TuiMouseEvent, visibleWidth,
} from "@earendil-works/pi-tui";
import {
	QuestionOptionControl,
	type QuestionOptionControlAction,
} from "../lib/questions/option-control.ts";

const hover = "\u001b[48;5;236m";
const theme = {
	selectedPrefix: (text: string) => `\u001b[38;5;39m${text}\u001b[39m`,
	selectedText: (text: string) => `\u001b[38;5;39m${text}\u001b[39m`,
	description: (text: string) => `\u001b[38;5;244m${text}\u001b[39m`,
	preview: (text: string) => `\u001b[38;5;110m${text}\u001b[39m`,
	hoverBackground: (text: string) => `${hover}${text}\u001b[49m`,
};
const items = [
	{ id: "direct", label: "Direct 🧭", description: "One focused path.", preview: "Ship directly." },
	{ id: "staged", label: "Staged", description: "A wider path with several steps.", preview: "Review each step." },
] as const;

function mouse(type: TuiMouseEvent["type"], button: TuiMouseEvent["button"], y: number, width: number, height: number, wheelDelta?: number): TuiMouseEvent {
	return { type, button, x: 0, y, screenX: 0, screenY: y, width, height, shift: false, alt: false, ctrl: false, wheelDelta };
}

function row(control: QuestionOptionControl, width: number, label: string) {
	const lines = control.render(width);
	assert.ok(lines.every((line) => visibleWidth(line) <= width));
	const y = lines.findIndex((line) => stripTerminalSequences(line).includes(label));
	assert.ok(y >= 0, `layout contains ${label}`);
	return { lines, y };
}

function rowHasHover(lines: readonly string[], label: string): boolean {
	const line = lines.find((value) => stripTerminalSequences(value).includes(label));
	assert.ok(line !== undefined, `layout contains ${label}`);
	return line!.includes(hover);
}

test("keyboard focus exposes exact authored preview metadata and selects without committing", () => {
	const actions: QuestionOptionControlAction[] = [];
	const control = new QuestionOptionControl({ items, multiSelect: false, theme, onAction: (action) => actions.push(action) });
	control.handleInput("\u001b[B");
	assert.equal(control.getFocusedOption(), items[1]);
	assert.deepEqual(actions, [{ type: "focus-option", index: 1, option: items[1] }]);
	control.handleInput("\r");
	assert.deepEqual(actions.at(-1), { type: "select-option", index: 1, option: items[1] });
	assert.match(stripTerminalSequences(control.render(48).join("\n")), /A wider path[\s\S]*Preview: Review each step\./);
});

test("single-select callers can keep previews out of the option rows for a side panel", () => {
	const control = new QuestionOptionControl({ items, multiSelect: false, theme, inlinePreview: false });
	const rendered = stripTerminalSequences(control.render(48).join("\n"));
	assert.match(rendered, /Direct 🧭[\s\S]*One focused path\./);
	assert.doesNotMatch(rendered, /Preview:/);
	control.handleInput("\u001b[B");
	assert.equal(control.getFocusedOption(), items[1]);
});

test("focused unselected options use accent and selected background without changing selection", () => {
	const actions: QuestionOptionControlAction[] = [];
	const control = new QuestionOptionControl({ items, multiSelect: false, theme, onAction: (action) => actions.push(action) });
	const initial = control.render(48).join("\n");
	assert.match(initial, /\u001b\[38;5;39m→ /, "focus uses the theme accent for its navigation marker");
	assert.match(initial, /\u001b\[38;5;39mDirect/, "focused text uses the theme accent");
	assert.match(initial, /\u001b\[48;5;236m/, "the focused row uses the subtle selected background");
	assert.match(stripTerminalSequences(initial), /→ \( \) Direct/, "focus is visibly distinct from selection");
	assert.deepEqual([...actions], [], "rendering an unselected focused option has no activation side effect");

	control.handleInput("\r");
	control.handleInput("\u001b[B");
	const moved = control.render(48).join("\n");
	assert.match(stripTerminalSequences(moved), /\(●\) Direct[\s\S]*→ \( \) Staged/,
		"moving focus preserves the existing single selection");
	assert.match(moved, /\u001b\[48;5;236m/, "the newly focused option keeps the selected background");
	assert.deepEqual(actions.map((action) => action.type), ["select-option", "focus-option"],
		"focus movement remains separate from option activation");
});

test("multi-select toggles independently, honors public configured bindings, and never submits", () => {
	const actions: QuestionOptionControlAction[] = [];
	const keybindings = new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "j", "tui.select.confirm": "x" });
	const control = new QuestionOptionControl({ items, multiSelect: true, theme, keybindings, onAction: (action) => actions.push(action) });
	control.handleInput("j");
	control.handleInput("x");
	control.handleInput("x");
	assert.deepEqual(actions.map((action) => action.type), ["focus-option", "toggle-option", "toggle-option"]);
	assert.deepEqual(actions.slice(1).map((action) => {
		if (action.type !== "toggle-option") throw new Error("expected toggle-option action");
		return action.selected;
	}), [true, false]);
	assert.doesNotMatch(stripTerminalSequences(control.render(48).join("\n")), /\[x\] Staged/);
});

test("hover is visual only while mouse press focuses, click activates, and wheel moves focus", () => {
	const actions: QuestionOptionControlAction[] = [];
	const control = new QuestionOptionControl({ items, multiSelect: true, theme, onAction: (action) => actions.push(action) });
	const staged = row(control, 42, "Staged");
	assert.equal(control.handleMouse(mouse("move", "none", staged.y, 42, staged.lines.length))?.render, true);
	assert.equal(control.getFocusedOption(), items[0], "hover must not move keyboard focus");
	const hovered = control.render(42);
	assert.equal(rowHasHover(hovered, "Staged"), true, "the independently hovered row uses the hover background");
	assert.equal(rowHasHover(hovered, "Direct"), rowHasHover(staged.lines, "Direct"), "the focused row keeps its baseline background");
	assert.equal(control.handleMouse(mouse("press", "left", staged.y, 42, staged.lines.length))?.focus, true);
	assert.deepEqual(actions.at(-1), { type: "focus-option", index: 1, option: items[1] });
	control.handleMouse(mouse("click", "left", staged.y, 42, staged.lines.length));
	assert.deepEqual(actions.at(-1), { type: "toggle-option", index: 1, option: items[1], selected: true });
	control.handleMouse(mouse("wheel", "none", staged.y, 42, staged.lines.length, -1));
	assert.deepEqual(actions.at(-1), { type: "focus-option", index: 0, option: items[0] });
});

test("display sanitizes terminal controls without mutating exact callback data or stale hover geometry", () => {
	const raw = { id: "raw", label: "\u001b[31mRaw\u001b[0m\nLine", description: "CJK 表示", preview: "Exact ✨ preview" };
	const actions: QuestionOptionControlAction[] = [];
	const control = new QuestionOptionControl({ items: [raw, items[1]], multiSelect: false, theme, onAction: (action) => actions.push(action) });
	const narrow = row(control, 18, "Raw");
	control.handleMouse(mouse("move", "none", narrow.y, 18, narrow.lines.length));
	const resized = control.render(28);
	assert.equal(rowHasHover(resized, "Staged"), rowHasHover(narrow.lines, "Staged"), "a width change clears hover from the non-focused row");
	assert.equal(rowHasHover(resized, "Raw"), rowHasHover(narrow.lines, "Raw"), "a width change preserves the focused row baseline");
	control.handleInput("\r");
	assert.deepEqual(actions.at(-1), { type: "select-option", index: 0, option: raw });
	assert.equal(raw.label, "\u001b[31mRaw\u001b[0m\nLine");
	assert.doesNotMatch(control.render(28).join("\n"), /\u001b\[31m/);
});

test("clamps narrow CJK and emoji output", () => {
	const control = new QuestionOptionControl({ items: [{ id: "wide", label: "表✨", description: "表✨" }, items[1]], multiSelect: false, theme });
	for (const width of [0, 1, 2]) {
		const lines = control.render(width);
		assert.ok(lines.every((line) => visibleWidth(line) <= width), `width ${width} must never overflow`);
		if (width === 0) assert.deepEqual(lines, []);
	}
});

test("removes standalone terminal controls without mutating callback metadata", () => {
	const raw = { id: "raw", label: "\u0007Bell\b \u009b31mC1\u009b0m\n表✨", description: "\u0007Detail\b", preview: "\u009dhidden\u0007Safe" };
	const actions: QuestionOptionControlAction[] = [];
	const control = new QuestionOptionControl({ items: [raw, items[1]], multiSelect: false, theme, onAction: (action) => actions.push(action) });
	const rendered = stripTerminalSequences(control.render(40).join("\n"));
	assert.match(rendered, /Bell C1[^\n]*\n\s*表✨[\s\S]*Detail[\s\S]*Safe/);
	assert.doesNotMatch(rendered, /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
	control.handleInput("\r");
	assert.deepEqual(actions.at(-1), { type: "select-option", index: 0, option: raw });
	assert.equal(raw.label, "\u0007Bell\b \u009b31mC1\u009b0m\n表✨");
});

test("requires a fresh frame for pointer actions and disposes permanently", () => {
	const actions: QuestionOptionControlAction[] = [];
	const control = new QuestionOptionControl({ items, multiSelect: false, theme, onAction: (action) => actions.push(action) });
	const stale = mouse("click", "left", 0, 42, 8);
	assert.equal(control.handleMouse(stale), undefined, "events before first render are inert");
	const staged = row(control, 42, "Staged");
	control.handleMouse(mouse("move", "none", staged.y, 42, staged.lines.length));
	control.invalidate();
	assert.equal(control.handleMouse(stale), undefined, "invalidated geometry cannot route clicks");
	const afterInvalidate = control.render(42);
	assert.equal(rowHasHover(afterInvalidate, "Staged"), rowHasHover(staged.lines, "Staged"), "invalidating geometry resets the non-focused hover to baseline");
	assert.equal(rowHasHover(afterInvalidate, "Direct"), rowHasHover(staged.lines, "Direct"), "invalidating geometry preserves the focused row baseline");
	const fresh = row(control, 42, "Staged");
	control.handleMouse(mouse("click", "left", fresh.y, 42, fresh.lines.length));
	control.setItems([{ id: "new", label: "New", description: "Fresh." }, items[1]]);
	assert.equal(control.handleMouse(stale), undefined, "item replacement invalidates old geometry");
	const replacement = row(control, 42, "New");
	control.handleMouse(mouse("click", "left", replacement.y, 42, replacement.lines.length));
	control.dispose();
	control.dispose();
	control.handleMouse(stale);
	control.handleInput("\r");
	assert.deepEqual(actions.map((action) => action.option.id), ["staged", "new"]);
	assert.deepEqual(control.render(42), []);
});

test("strictly rejects duplicate item IDs and invalid selections without changing state", () => {
	assert.throws(() => new QuestionOptionControl({
		items: [{ id: "same", label: "First", description: "A" }, { id: "same", label: "Second", description: "B" }],
		multiSelect: false, theme,
	}), TypeError, "a duplicate second row cannot route to the first item");
	const control = new QuestionOptionControl({ items, multiSelect: true, theme, selectedIds: ["direct"] });
	assert.throws(() => control.setSelectedIds(["unknown"]), TypeError);
	assert.throws(() => control.setSelectedIds(["direct", "direct"]), TypeError);
	assert.match(stripTerminalSequences(control.render(42).join("\n")), /\[x\] Direct/);
	const single = new QuestionOptionControl({ items, multiSelect: false, theme });
	assert.throws(() => single.setSelectedIds(["direct", "staged"]), TypeError);
	assert.throws(() => new QuestionOptionControl({ items, multiSelect: false, theme, selectedIds: ["direct", "staged"] }), TypeError);
});

test("rejects pointer events whose width differs from the rendered frame", () => {
	const actions: QuestionOptionControlAction[] = [];
	const control = new QuestionOptionControl({ items, multiSelect: false, theme, onAction: (action) => actions.push(action) });
	const staged = row(control, 42, "Staged");
	assert.equal(control.handleMouse(mouse("move", "none", staged.y, 41, staged.lines.length)), undefined);
	assert.equal(control.handleMouse(mouse("click", "left", staged.y, 41, staged.lines.length)), undefined);
	assert.deepEqual([...actions], []);
	const afterWidthMismatch = control.render(42);
	assert.equal(rowHasHover(afterWidthMismatch, "Staged"), rowHasHover(staged.lines, "Staged"), "a mismatched width cannot hover the non-focused row");
	assert.equal(rowHasHover(afterWidthMismatch, "Direct"), rowHasHover(staged.lines, "Direct"), "a mismatched width preserves the focused row baseline");
	control.render(0);
	assert.equal(control.handleMouse(mouse("click", "left", staged.y, 42, staged.lines.length)), undefined);
	const fresh = row(control, 42, "Staged");
	control.handleMouse(mouse("click", "left", fresh.y, 42, fresh.lines.length));
	assert.deepEqual(actions.map((action) => {
		if (action.type !== "select-option") throw new Error("expected select-option action");
		return action.option.id;
	}), ["staged"]);
});

test("mouse observers follow item replacement and become inert after disposal", () => {
	const control = new QuestionOptionControl({ items, multiSelect: false, theme });
	let renders = 0;
	const observer = control.createMouseObserver(() => { renders++; });
	control.setItems([{ id: "new", label: "New", description: "Fresh." }, items[1]]);
	const fresh = row(control, 42, "New");
	control.setFocusedId(items[1].id);
	const baseline = control.render(42);
	const inside = mouse("move", "none", fresh.y, 42, fresh.lines.length);
	observer.beforeMouse(inside);
	control.handleMouse(inside);
	observer.afterMouse(inside);
	const hovered = control.render(42);
	assert.equal(rowHasHover(hovered, "New"), true, "the replaced non-focused row responds to observer hover");
	const outside = mouse("move", "none", fresh.lines.length, 42, fresh.lines.length + 1);
	observer.beforeMouse(outside);
	control.handleMouse(outside);
	observer.afterMouse(outside);
	const reset = control.render(42);
	assert.equal(rowHasHover(reset, "New"), rowHasHover(baseline, "New"), "leaving the row restores its baseline background");
	control.dispose();
	observer.beforeMouse(inside);
	observer.afterMouse(inside);
	assert.equal(renders, 1);
});
