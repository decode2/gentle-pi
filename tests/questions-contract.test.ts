import assert from "node:assert/strict";
import test from "node:test";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";
import { validateAndFormat } from "../lib/questions/response.ts";

const input = {
	questions: [{
		question: "Which delivery path?",
		header: "Delivery",
		options: [
			{ label: "Direct", description: "One path.", preview: "direct preview" },
			{ label: "Staged", description: "Two paths." },
		],
	}, {
		question: "Which checks?",
		header: "Checks",
		multiSelect: true,
		options: [
			{ label: "Unit", description: "Focused." },
			{ label: "Integration", description: "Broader." },
		],
	}],
};

function frozenRequest() {
	const created = createFrozenQuestionnaireRequest("correlation-1", input);
	assert.equal(created.ok, true, "the fixture is a valid public questionnaire");
	return created.request;
}

function raw(overrides: Record<string, unknown> = {}) {
	return {
		correlationId: "correlation-1",
		cancelled: false,
		answers: [{
			questionIndex: 0,
			question: "Which delivery path?",
			kind: "option",
			answer: "Direct",
			preview: "direct preview",
			notes: "Prefer the short path.",
		}],
		...overrides,
	};
}

test("freezes a protocol-correlated request including nested options and previews", () => {
	const request = frozenRequest();
	assert.equal(request.protocol, "gentle-pi/questions/v1");
	assert.equal(Object.isFrozen(request), true);
	assert.equal(Object.isFrozen(request.questions), true);
	assert.equal(Object.isFrozen(request.questions[0]!.options[0]!), true);
	assert.throws(() => { (request.questions[0]!.options[0] as { label: string }).label = "Changed"; }, TypeError);
	assert.equal(request.questions[0]!.options[0]!.preview, "direct preview");
});

test("rejects actual questionnaire schema violations without trimming valid text", () => {
	const cases: Array<[string, unknown]> = [
		["empty questions", { questions: [] }],
		["five questions", { questions: Array.from({ length: 5 }, () => input.questions[0]) }],
		["long header", { questions: [{ ...input.questions[0], header: "x".repeat(17) }] }],
		["one option", { questions: [{ ...input.questions[0], options: [input.questions[0]!.options[0]] }] }],
		["five options", { questions: [{ ...input.questions[0], options: Array.from({ length: 5 }, () => input.questions[0]!.options[0]) }] }],
		["long label", { questions: [{ ...input.questions[0], options: [{ label: "x".repeat(61), description: "x" }, input.questions[0]!.options[1]] }] }],
		["reserved sentinel", { questions: [{ ...input.questions[0], options: [{ label: "Next", description: "x" }, input.questions[0]!.options[1]] }] }],
		["duplicate question", { questions: [input.questions[0], input.questions[0]] }],
		["duplicate option", { questions: [{ ...input.questions[0], options: [{ label: "Same", description: "x" }, { label: "Same", description: "y" }] }] }],
	];
	for (const [name, invalid] of cases) {
		const created = createFrozenQuestionnaireRequest("c", invalid);
		assert.equal(created.ok, false, name);
		if (!created.ok) assert.equal(created.failure.code, "invalid_input");
	}
	const preserved = createFrozenQuestionnaireRequest("c", { questions: [{
		...input.questions[0], question: "  Literal whitespace  ", header: "  Header  ",
	}] });
	assert.equal(preserved.ok, true);
	if (preserved.ok) assert.equal(preserved.request.questions[0]!.question, "  Literal whitespace  ");
});

test("formats an option answer with its exact selected preview and notes", () => {
	const formatted = validateAndFormat(frozenRequest(), raw());
	assert.equal(formatted.ok, true);
	if (formatted.ok) {
		assert.equal(formatted.result.content[0].text, "User has answered your questions: \"Which delivery path?\"=\"Direct\". selected preview: direct preview. user notes: Prefer the short path.. You can now continue with the user's answers in mind.");
		assert.equal(formatted.result.details.answers[0]!.preview, "direct preview");
	}
});

test("formats multi-select and free-text outcomes", () => {
	const multi = validateAndFormat(frozenRequest(), raw({ answers: [{
		questionIndex: 1, question: "Which checks?", kind: "multi", answer: null,
		selected: ["Unit", "Integration"],
	}] }));
	assert.equal(multi.ok, true);
	if (multi.ok) assert.match(multi.result.content[0].text, /"Which checks\?"="Unit, Integration"/);
	const custom = validateAndFormat(frozenRequest(), raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "custom", answer: "Bring my own path",
	}] }));
	assert.equal(custom.ok, true);
	if (custom.ok) assert.match(custom.result.content[0].text, /"Which delivery path\?"="Bring my own path"/);
	const empty = validateAndFormat(frozenRequest(), raw({ answers: [{ questionIndex: 0, question: "Which delivery path?", kind: "custom", answer: null }] }));
	assert.equal(empty.ok, true);
	if (empty.ok) assert.match(empty.result.content[0].text, /"Which delivery path\?"="\(no input\)"/);
	const longAnswer = "x".repeat(10_000);
	const unbounded = validateAndFormat(frozenRequest(), raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "custom", answer: longAnswer,
	}] }));
	assert.equal(unbounded.ok, true, "the contract adds no unadvertised raw text limit");
});

test("preserves partial submissions and makes cancellation canonically decline", () => {
	const partial = validateAndFormat(frozenRequest(), raw({ globalNote: "Ship after review." }));
	assert.equal(partial.ok, true);
	if (partial.ok) assert.match(partial.result.content[0].text, /global note: Ship after review\./);
	const cancelled = validateAndFormat(frozenRequest(), raw({ cancelled: true, globalNote: "Keep this context." }));
	assert.equal(cancelled.ok, true);
	if (cancelled.ok) {
		assert.equal(cancelled.result.content[0].text, "User declined to answer questions");
		assert.equal(cancelled.result.details.globalNote, "Keep this context.");
		assert.equal(cancelled.result.details.answers.length, 1, "partial answer details survive cancellation");
	}
});

test("rejects hidden own keys while accepting JSON-compatible outcomes", () => {
	const compatible = JSON.parse(JSON.stringify(raw()));
	assert.equal(validateAndFormat(frozenRequest(), compatible).ok, true);
	const hiddenTopLevel = raw();
	Object.defineProperty(hiddenTopLevel, "approvalToken", { value: "opaque" });
	const symbolTopLevel = raw();
	Object.defineProperty(symbolTopLevel, Symbol("opaque"), { value: "opaque" });
	const hiddenAnswer = raw();
	Object.defineProperty(hiddenAnswer.answers[0]!, "approvalToken", { value: "opaque" });
	for (const outcome of [hiddenTopLevel, symbolTopLevel, hiddenAnswer]) {
		assert.equal(validateAndFormat(frozenRequest(), outcome).ok, false);
	}
});

test("rejects explicitly undefined optional own fields while accepting absent and string values", () => {
	const absentGlobal = raw({ answers: [] });
	const stringGlobal = raw({ answers: [], globalNote: "Keep context." });
	const undefinedGlobal = raw({ answers: [], globalNote: undefined });
	const absentNotes = raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Direct", preview: "direct preview",
	}] });
	const stringNotes = raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Direct", preview: "direct preview", notes: "Prefer direct.",
	}] });
	const undefinedNotes = raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Direct", preview: "direct preview", notes: undefined,
	}] });
	const absentPreview = raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Staged",
	}] });
	const stringPreview = raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Direct", preview: "direct preview",
	}] });
	const undefinedPreview = raw({ answers: [{
		questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Staged", preview: undefined,
	}] });
	for (const [name, outcome] of [["absent global", absentGlobal], ["string global", stringGlobal], ["absent notes", absentNotes], ["string notes", stringNotes], ["absent preview", absentPreview], ["string preview", stringPreview]] as const) {
		assert.equal(validateAndFormat(frozenRequest(), outcome).ok, true, name);
	}
	for (const [name, outcome] of [["undefined global", undefinedGlobal], ["undefined notes", undefinedNotes], ["undefined preview", undefinedPreview]] as const) {
		assert.equal(validateAndFormat(frozenRequest(), outcome).ok, false, name);
	}
});

test("rejects untrusted outcomes with a structured failure", () => {
	const cases: Array<[string, unknown]> = [
		["correlation", raw({ correlationId: "other" })],
		["index", raw({ answers: [{ questionIndex: 4, question: "Which delivery path?", kind: "option", answer: "Direct" }] })],
		["identity", raw({ answers: [{ questionIndex: 0, question: "Different", kind: "option", answer: "Direct" }] })],
		["option", raw({ answers: [{ questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Unknown" }] })],
		["duplicate", raw({ answers: [raw().answers[0], raw().answers[0]] })],
		["preview", raw({ answers: [{ questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Direct", preview: "forged" }] })],
		["undefined optional", raw({ answers: [{ questionIndex: 0, question: "Which delivery path?", kind: "option", answer: "Direct", notes: undefined }] })],
		["opaque property", raw({ approvalToken: "granted" })],
	];
	for (const [name, outcome] of cases) {
		const formatted = validateAndFormat(frozenRequest(), outcome);
		assert.equal(formatted.ok, false, name);
		if (!formatted.ok) {
			assert.equal(formatted.failure.code, "invalid_response");
			assert.equal(formatted.result.details.error, "invalid_response");
			assert.equal(formatted.result.details.cancelled, true);
		}
	}
});
