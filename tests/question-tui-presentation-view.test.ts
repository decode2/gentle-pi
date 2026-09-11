import assert from "node:assert/strict";
import test from "node:test";
import { StdinBuffer, stripTerminalSequences, type TUI, type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import type { QuestionnaireExternalEditor } from "../lib/questions/external-editor.ts";
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

test("Ctrl+G launches the external editor only from a custom-answer draft", async () => {
	const calls: string[] = [];
	const externalEditor: QuestionnaireExternalEditor = async (content) => {
		calls.push(content);
		return "edited externally";
	};
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {}, externalEditor,
	} as ConstructorParameters<typeof QuestionnaireTuiPresentation>[0] & { externalEditor: QuestionnaireExternalEditor });

	component.handleInput("\t");
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
	component.handleInput("\t");
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

test("Ctrl+G is ignored from an option tab", async () => {
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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

test("Ctrl+] collapses a custom draft to only the privacy hint, restores it, and Escape cancels", () => {
	const outcomes: unknown[] = [];
	const { component } = view((outcome) => outcomes.push(outcome));
	component.handleInput("\t");
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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
	component.handleInput("\t");
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
		"chrome.tab.options": "Optionen",
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
	assert.match(translated, /Frage 1:[\s\S]*Optionen[\s\S]*Eigene Antwort[\s\S]*Vorschau: exact preview[\s\S]*Weiter[\s\S]*Abbrechen/);
	assert.match(translated, /Route[\s\S]*Choose a route[\s\S]*Direct[\s\S]*Fast[\s\S]*exact preview/, "request content remains byte-preserved");

	component.handleInput("\t");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Eigene Eingabe \(Esc behält Entwurf\)/, "the editor label is static chrome");
	component.handleInput("\u001b");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Eigene Eingabe:/, "the persisted custom label is static chrome");
	component.handleInput("\t");
	component.handleInput("\r");
	component.handleInput("n");
	assert.match(stripTerminalSequences(component.render(48).join("\n")), /Frage 2:[\s\S]*Absenden[\s\S]*Abbrechen/, "the last-question primary label is static chrome");

	german = false;
	component.handleInput("\r");
	const rebuilt = stripTerminalSequences(component.render(48).join("\n"));
	assert.match(rebuilt, /Question 2:[\s\S]*Options[\s\S]*Custom answer[\s\S]*Submit[\s\S]*Cancel/);
});

test("a configured collapse key replaces Ctrl+] and displays its normalized key", () => {
	type FutureCollapseOptions = ConstructorParameters<typeof QuestionnaireTuiPresentation>[0] & { collapseKey?: string };
	const component = new QuestionnaireTuiPresentation({
		request: request(), tui: { terminal: { rows: 24 }, requestRender() {} } as TUI, theme, onDone() {}, collapseKey: "ctrl+k",
	} as FutureCollapseOptions);
	component.handleInput("\t");
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
	component.handleInput("\t");
	component.handleInput("private draft");
	component.handleInput("\u001d");
	component.handleInput("\u000b");
	const expanded = stripTerminalSequences(component.render(48).join("\n"));
	assert.match(expanded, /Custom response/, "disabled collapse never enters hidden state");
	assert.doesNotMatch(expanded, /to expand · Esc to cancel/);
});
