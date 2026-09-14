import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { RawQuestionnaireOutcome } from "../lib/questions/contract.ts";
import type { QuestionnaireLocalizer } from "../lib/questions/localization.ts";
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

function emptyMultiSubmitRequest() {
	const result = createFrozenQuestionnaireRequest("empty-multi-submit-correlation", { questions: [{
		question: "Choose checks", header: "Checks", multiSelect: true, options: [
			{ label: "First", description: "First check." }, { label: "Second", description: "Second check." },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("empty multi submit fixture must be valid");
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

function owned(outcome: unknown): RawQuestionnaireOutcome {
	assertOwnedOutcome(outcome);
	return outcome;
}

function assertOwnedOutcome(value: unknown): asserts value is RawQuestionnaireOutcome {
	const formatted = validateAndFormat(request(), value);
	assert.equal(formatted.ok, true, "driver raw outcome belongs to the owner validator");
	if (!formatted.ok) throw new Error("driver raw outcome belongs to the owner validator");
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
	assert.deepEqual(ui.calls[0]!.values, ["Choose an option", "Use custom text", "Skip", "Next", "Submit partial", "Cancel"]);
	assert.deepEqual(ui.calls[1]!.values, ["Back", "Submit"]);
});

test("preserves multiline custom text and ordered multi toggles without note controls", async () => {
	const ui = new FakeUi([
		"Choose an option", "Back", "Next",
		"Choose options", "Second", "Choose options", "First", "Next",
		"Use custom text", "  custom\ntext  ", "Submit",
	]);
	const outcome = owned(await createRpcQuestionPresentationDriver(ui).present(request()));
	assert.deepEqual(outcome, {
		correlationId: "rpc-correlation", cancelled: false, answers: [
			{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Back", preview: "Exact\npreview" },
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

test("explicit Submit commits an untouched empty multi as non-cancelled no input", async () => {
	const questionnaire = emptyMultiSubmitRequest();
	const ui = new FakeUi(["Submit"]);
	const outcome = await createRpcQuestionPresentationDriver(ui).present(questionnaire);
	const formatted = validateAndFormat(questionnaire, outcome);
	assert.equal(formatted.ok, true, "the RPC emits the owned raw outcome shape");
	if (!formatted.ok) throw new Error("empty multi submission must be valid");
	assert.equal(formatted.result.details.cancelled, false);
	assert.equal(formatted.result.details.answers.length, 1);
	const multi = formatted.result.details.answers[0];
	if (!multi || multi.kind !== "multi" || multi.question !== "Choose checks") throw new Error("explicit Submit must commit the only empty multi answer");
	assert.deepEqual(multi.selected, []);
	assert.match(formatted.result.content[0]!.text, /"Choose checks"="\(no input\)"/);
	assert.doesNotMatch(formatted.result.content[0]!.text, /^User declined to answer questions$/);
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

test("propagates native RPC dialog rejection instead of converting it to cancellation", async () => {
	const rejection = new Error("native-select-rejection");
	const ui = new FakeUi([Promise.reject(rejection)]);
	await assert.rejects(async () => createRpcQuestionPresentationDriver(ui).present(request()), rejection);
	assert.equal(ui.calls.length, 1);
});

type LocalizedRpcDriverFactory = (
	ui: Pick<ExtensionUIContext, "select" | "editor">,
	localize?: QuestionnaireLocalizer,
) => ReturnType<typeof createRpcQuestionPresentationDriver>;

const createLocalizedRpcDriver = createRpcQuestionPresentationDriver as LocalizedRpcDriverFactory;

function localizer(translations: Record<string, string>, lookups: Array<[string, string]>): QuestionnaireLocalizer {
	return (key, fallback) => {
		lookups.push([key, fallback]);
		return translations[fallback] ?? fallback;
	};
}

test("localizes RPC chrome while preserving authored option labels and canonical answers", async () => {
	const lookups: Array<[string, string]> = [];
	const ui = new FakeUi(["Eine Option wählen", "Back", "Weiter", "Teilweise absenden"]);
	const outcome = owned(await createLocalizedRpcDriver(ui, localizer({
		"Question {index}:": "Frage {index}:",
		"Static preview (RPC; full TUI detail unavailable):": "Statische Vorschau (RPC; vollständige TUI-Details nicht verfügbar):",
		"Choose an option": "Eine Option wählen",
		"Use custom text": "Eigenen Text verwenden",
		"Skip": "Überspringen",
		"Next": "Weiter",
		"Submit partial": "Teilweise absenden",
		"Cancel": "Abbrechen",
	}, lookups)).present(request()));

	assert.deepEqual(outcome.answers, [{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Back", preview: "Exact\npreview" }]);
	assert.equal(outcome.cancelled, false);
	assert.equal(ui.calls[0]!.title, "Frage 1: Route\nChoose a route\n\nStatische Vorschau (RPC; vollständige TUI-Details nicht verfügbar):\nBack\nAn authored label.\nStatic preview: Exact\npreview\n\nSubmit\nAnother authored label.");
	assert.deepEqual(ui.calls[0]!.values, ["Eine Option wählen", "Eigenen Text verwenden", "Überspringen", "Weiter", "Teilweise absenden", "Abbrechen"]);
	assert.deepEqual(ui.calls[1]!.values, ["Back", "Submit"], "authored option labels remain the only option dialog values");
	assert.equal(lookups.some(([, fallback]) => ["Route", "Choose a route", "An authored label.", "Exact\npreview"].includes(fallback)), false, "authored question content is never localized");
});

test("localizes the RPC custom editor title without changing multiline custom input", async () => {
	const ui = new FakeUi(["Usar texto personalizado", "  línea\nmanual  ", "Siguiente", "Enviar parcialmente"]);
	const outcome = owned(await createLocalizedRpcDriver(ui, localizer({
		"Use custom text": "Usar texto personalizado",
		"Next": "Siguiente",
		"Submit partial": "Enviar parcialmente",
		"Custom response": "Respuesta personalizada",
	}, [])).present(request()));

	assert.deepEqual(outcome.answers, [{ questionIndex: 0, question: "Choose a route", kind: "custom", answer: "  línea\nmanual  " }]);
	assert.equal(outcome.cancelled, false);
	assert.deepEqual(ui.calls[1], { kind: "editor", title: "Respuesta personalizada", prefill: undefined });
});

test("routes a pending RPC selection through its captured localized labels after the provider language changes", async () => {
	let language = "de";
	let release!: (value: string) => void;
	const first = new Promise<string>((resolve) => { release = resolve; });
	const ui = new FakeUi([first, "Back", "Siguiente", "Enviar parcialmente"]);
	const lookups: Array<[string, string]> = [];
	const translate = localizer({
		"Choose an option": "Eine Option wählen",
		"Use custom text": "Eigenen Text verwenden",
		"Skip": "Überspringen",
		"Next": "Weiter",
		"Submit partial": "Teilweise absenden",
		"Cancel": "Abbrechen",
	}, lookups);
	const liveLocalizer: QuestionnaireLocalizer = (key, fallback) => language === "de"
		? translate(key, fallback)
		: localizer({ "Next": "Siguiente", "Submit partial": "Enviar parcialmente" }, lookups)(key, fallback);
	const presenting = createLocalizedRpcDriver(ui, liveLocalizer).present(request());
	await Promise.resolve();
	language = "es";
	release("Eine Option wählen");
	const outcome = owned(await presenting);

	assert.equal(ui.calls[0]!.values![0], "Eine Option wählen");
	assert.ok(ui.calls[2]!.values!.includes("Siguiente"), "the next dialog rebuilds labels for the new provider language");
	assert.deepEqual(outcome.answers, [{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Back", preview: "Exact\npreview" }]);
	assert.equal(outcome.cancelled, false);
});

test("cancels instead of guessing when localized action labels collide", async () => {
	const ui = new FakeUi(["Choose an option", "Back", "Submit"]);
	const outcome = owned(await createLocalizedRpcDriver(ui, localizer({
		"Choose an option": "Choose an option",
		"Use custom text": "Choose an option",
	}, [])).present(request()));

	assert.equal(outcome.cancelled, true);
	assert.deepEqual(outcome.answers, []);
	assert.ok(ui.calls.length <= 1, "an ambiguous action must not enter an option dialog or execute an arbitrary action");
});

test("cancels an English action label when the displayed RPC menu is localized", async () => {
	const ui = new FakeUi(["Choose an option", "Back", "Submit"]);
	const outcome = owned(await createLocalizedRpcDriver(ui, localizer({ "Choose an option": "Eine Option wählen" }, [])).present(request()));

	assert.equal(outcome.cancelled, true);
	assert.deepEqual(outcome.answers, []);
	assert.equal(ui.calls.length, 1, "a label that was not displayed has no routing alias");
});
