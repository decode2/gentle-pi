import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createRpcQuestionPresentationDriver } from "../lib/questions/rpc-presentation-driver.ts";
import { validateAndFormat } from "../lib/questions/response.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

type Reply = string | undefined | Promise<string | undefined>;
type Call = { kind: "select" | "editor"; title: string; values?: string[]; prefill?: string };

const input = { questions: [{
	question: "Choose a route", header: "Route", options: [
		{ label: "Back", description: "An authored label.", preview: "Exact\npreview" },
		{ label: "Submit", description: "Another authored label." },
	],
}, {
	question: "Choose checks", header: "Checks", multiSelect: true, options: [
		{ label: "First", description: "First check." }, { label: "Second", description: "Second check." },
	],
}, {
	question: "Add context", header: "Context", options: [
	{ label: "Keep", description: "Keep defaults." }, { label: "Change", description: "Change defaults." },
], }] };

function request() {
	const result = createFrozenQuestionnaireRequest("rpc-correlation", input);
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("fixture must be valid");
	return result.request;
}

class FakeUi implements Pick<ExtensionUIContext, "select" | "editor"> {
	readonly calls: Call[] = [];
	private busy = false;
	private position = 0;
	private readonly replies: Reply[];
	constructor(replies: Reply[]) { this.replies = replies; }
	async select(title: string, values: string[]): Promise<string | undefined> {
		return this.ask({ kind: "select", title, values: [...values] });
	}
	async editor(title: string, prefill?: string): Promise<string | undefined> {
		return this.ask({ kind: "editor", title, prefill });
	}
	private async ask(call: Call): Promise<string | undefined> {
		assert.equal(this.busy, false, "dialogs are never concurrent");
		this.busy = true;
		this.calls.push(call);
		assert.ok(this.position < this.replies.length, "test script supplies every dialog result");
		const result = await this.replies[this.position++];
		this.busy = false;
		return result;
	}
}

function owned(outcome: unknown) {
	const formatted = validateAndFormat(request(), outcome);
	assert.equal(formatted.ok, true, "driver raw outcome belongs to the owner validator");
	return outcome;
}

test("presents exact static descriptions and frozen previews while keeping routing separate", async () => {
	const ui = new FakeUi(["Choose an option", "Back", "Next", "Submit partial"]);
	const outcome = owned(await createRpcQuestionPresentationDriver(ui).present(request()));
	assert.deepEqual(outcome, {
		correlationId: "rpc-correlation", cancelled: false,
		answers: [{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Back", preview: "Exact\npreview" }],
	});
	assert.equal(ui.calls[0]!.kind, "select");
	assert.equal(ui.calls[0]!.title, "Question 1: Route\nChoose a route\n\nStatic preview (RPC; full TUI detail unavailable):\nBack\nAn authored label.\nStatic preview: Exact\npreview\n\nSubmit\nAnother authored label.");
	assert.deepEqual(ui.calls[0]!.values, ["Choose an option", "Use custom text", "Add question note", "Add global note", "Skip", "Next", "Submit partial", "Cancel"]);
	assert.deepEqual(ui.calls[1]!.values, ["Back", "Submit"]);
});

test("preserves multiline custom text and notes, ordered multi toggles, and global notes", async () => {
	const ui = new FakeUi([
		"Choose an option", "Back", "Add question note", "note\nexact", "Next",
		"Choose options", "Second", "Choose options", "First", "Next",
		"Use custom text", "  custom\ntext  ", "Add global note", "global\nnote", "Submit",
	]);
	const outcome = owned(await createRpcQuestionPresentationDriver(ui).present(request()));
	assert.deepEqual(outcome, {
		correlationId: "rpc-correlation", cancelled: false, globalNote: "global\nnote", answers: [
			{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Back", preview: "Exact\npreview", notes: "note\nexact" },
			{ questionIndex: 1, question: "Choose checks", kind: "multi", answer: null, selected: ["First", "Second"] },
			{ questionIndex: 2, question: "Add context", kind: "custom", answer: "  custom\ntext  " },
		],
	});
});

test("supports multi-select custom drafts and switches their active tab back to options", async () => {
	const scripts: Array<[Reply[], unknown]> = [
		[["Next", "Use custom text", "multi\ncustom", "Next", "Cancel"], {
			correlationId: "rpc-correlation", cancelled: true,
			answers: [{ questionIndex: 1, question: "Choose checks", kind: "custom", answer: "multi\ncustom" }],
		}],
		[["Next", "Use custom text", "", "Next", "Cancel"], {
			correlationId: "rpc-correlation", cancelled: true,
			answers: [{ questionIndex: 1, question: "Choose checks", kind: "custom", answer: "" }],
		}],
		[["Next", "Choose options", "Second", "Use custom text", "discarded", "Choose options", "First", "Next", "Cancel"], {
			correlationId: "rpc-correlation", cancelled: true,
			answers: [{ questionIndex: 1, question: "Choose checks", kind: "multi", answer: null, selected: ["First", "Second"] }],
		}],
	];
	for (const [replies, expected] of scripts) {
		const ui = new FakeUi(replies);
		assert.deepEqual(owned(await createRpcQuestionPresentationDriver(ui).present(request())), expected);
		assert.ok(ui.calls[1]!.values!.includes("Use custom text"));
	}
});

test("commits deliberately empty multi and empty custom drafts only through Next", async () => {
	const ui = new FakeUi(["Skip", "Choose options", "First", "Choose options", "First", "Next", "Use custom text", "", "Submit"]);
	const outcome = owned(await createRpcQuestionPresentationDriver(ui).present(request()));
	assert.deepEqual(outcome.answers, [
		{ questionIndex: 1, question: "Choose checks", kind: "multi", answer: null, selected: [] },
		{ questionIndex: 2, question: "Add context", kind: "custom", answer: "" },
	]);
});

test("backs up without erasing commits, revisits custom as options, and cancels partial results", async () => {
	const ui = new FakeUi(["Use custom text", "draft", "Next", "Back", "Choose an option", "Submit", "Next", "Cancel"]);
	const outcome = owned(await createRpcQuestionPresentationDriver(ui).present(request()));
	assert.deepEqual(outcome, {
		correlationId: "rpc-correlation", cancelled: true,
		answers: [{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Submit" }],
	});
});

test("cancels on undefined or unexpected dialog output without another dialog", async () => {
	for (const replies of [[undefined], ["Unknown routing action"], ["Use custom text", undefined]] as Reply[][]) {
		const ui = new FakeUi(replies);
		const outcome = owned(await createRpcQuestionPresentationDriver(ui).present(request()));
		assert.equal(outcome.cancelled, true);
		assert.equal(ui.calls.length, replies.length);
	}
});

test("awaits each RPC dialog before requesting the next", async () => {
	let release: ((value: string) => void) | undefined;
	const first = new Promise<string>((resolve) => { release = resolve; });
	const ui = new FakeUi([first, "Cancel"]);
	const presenting = createRpcQuestionPresentationDriver(ui).present(request());
	await Promise.resolve();
	assert.equal(ui.calls.length, 1);
	release!("Next");
	const outcome = owned(await presenting);
	assert.equal(outcome.cancelled, true);
	assert.equal(ui.calls.length, 2);
});
