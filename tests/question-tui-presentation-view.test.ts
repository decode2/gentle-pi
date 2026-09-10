import assert from "node:assert/strict";
import test from "node:test";
import { StdinBuffer, stripTerminalSequences, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { QuestionnaireTuiPresentation } from "../lib/questions/tui-presentation-view.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

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

function view(done: (outcome: unknown) => void = () => {}) {
	let renders = 0;
	const component = new QuestionnaireTuiPresentation({ request: request(), tui: { terminal: { rows: 24 }, requestRender: () => { renders++; } } as TUI, theme, onDone: done });
	return { component, renders: () => renders };
}

function mouse(width: number, y = 0, height = 24): TuiMouseEvent {
	return { type: "click", button: "left", x: 0, y, screenX: 0, screenY: y, width, height, shift: false, alt: false, ctrl: false };
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

test("selecting is display-only until Next, then Submit emits reducer-owned frozen metadata once", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Question 1[\s\S]*Options[\s\S]*Custom[\s\S]*exact preview/);
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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
	component.handleInput("\t");
	component.handleInput("first");
	const navigationFrame = component.render(48);
	component.handleMouse(mouse(48, 1, navigationFrame.length));
	component.handleInput("\t");
	component.handleInput("second");
	component.handleInput("\u001b");
	component.handleInput("[");
	component.handleInput("\t");
	component.handleInput("\t");
	component.handleInput("\u001b");
	component.handleInput("n");
	component.handleInput("]");
	component.handleInput("\t");
	component.handleInput("\t");
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
	hidden.handleInput("\t");
	hidden.handleInput("\u001b");
	hidden.handleInput("\r");
	hidden.handleInput("\t");
	hidden.handleInput("n");
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
	component.handleInput("\t");
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
	navigated.handleInput("\t");
	navigated.handleInput("\u001b[200~nav");
	navigated.handleInput("\u001b");
	click(navigated, "2. Checks");
	navigated.handleInput("[");
	navigated.handleInput("\t");
	navigated.handleInput("\t");
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
	finished.handleInput("\t");
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
	component.handleInput("\t");
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

test("Options closes an active custom editor without losing its draft, including an explicit empty custom answer", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	clickVisible(component, /Custom/);
	component.handleInput("saved draft");
	clickVisible(component, "Options");
	assert.doesNotMatch(stripTerminalSequences(component.render(20).join("\n")), /Custom response/, "Options restores option controls instead of leaving the custom editor open");
	assert.match(stripTerminalSequences(component.render(20).join("\n")), /Direct/, "Options are visible after the pointer switch");
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
