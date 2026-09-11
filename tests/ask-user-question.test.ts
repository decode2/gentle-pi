import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createAskUserQuestionExtension, type AskUserQuestionDependencies } from "../extensions/ask-user-question.ts";
import type { QuestionOwnerConfigResolution } from "../lib/questions/owner-config.ts";
import type { QuestionnaireGuidance } from "../lib/questions/guidance-config.ts";
import type { QuestionPresentationDriver } from "../lib/questions/contract.ts";
import type { QuestionnaireLocalizer } from "../lib/questions/localization.ts";
import { createRpcQuestionPresentationDriver } from "../lib/questions/rpc-presentation-driver.ts";

type LocalizedRpcDriverFactory = (
	ui: Parameters<typeof createRpcQuestionPresentationDriver>[0],
	localize?: QuestionnaireLocalizer,
) => QuestionPresentationDriver;

// RED seam: production still has one argument and therefore ignores this localizer.
const createLocalizedRpcDriver = createRpcQuestionPresentationDriver as LocalizedRpcDriverFactory;

type TestUi = { custom?: unknown; select?: (title: string, options: string[]) => Promise<string | undefined>; editor?: (title: string, prefill?: string) => Promise<string | undefined> };
type SessionHandler = (event: unknown, ctx: { mode: string; hasUI?: boolean; ui: TestUi }) => Promise<void> | void;
type RegisteredTool = {
	name: string;
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	parameters: { properties?: Record<string, unknown> };
	execute: (...args: unknown[]) => Promise<unknown>;
};
type EventRecord = { channel: string; payload: unknown };
type EventContract = {
	sourceEventContractOracle: {
		valid: {
			input: { questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string; preview?: string }> }> };
			promptPayload: unknown;
			pendingEvents: Array<{ channel: string; payload: unknown }>;
			releaseEvent: EventRecord;
		};
	};
	observedRegistrarNoQuestionsEnvelope: { input: unknown; events: EventRecord[]; errorEnvelope: unknown };
};

const eventContract = JSON.parse(readFileSync(new URL("./fixtures/questions/legacy-2.9.0/event-contract.json", import.meta.url), "utf8")) as EventContract;

function owner(ownerName: "gentle-pi" | "legacy-external" | "disabled"): QuestionOwnerConfigResolution {
	return ownerName === "gentle-pi"
		? { allowRegistration: true, owner: "gentle-pi", reason: "configured_gentle_pi", path: "/profiles/test/gentle-ai/question-owner.json" }
		: { allowRegistration: false, owner: ownerName, reason: ownerName === "disabled" ? "configured_disabled" : "configured_external", path: "/profiles/test/gentle-ai/question-owner.json" };
}

function host(inventory: string[] = []) {
	const sessionStarts: SessionHandler[] = [];
	const tools: RegisteredTool[] = [];
	const events: EventRecord[] = [];
	let inventoryCalls = 0;
	const pi = {
		on(event: string, handler: SessionHandler) { if (event === "session_start") sessionStarts.push(handler); },
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		getAllTools() { inventoryCalls++; return inventory.map((name) => ({ name })); },
		events: { emit(channel: string, payload: unknown) { events.push({ channel, payload }); } },
	};
	return { pi, sessionStarts, tools, events, inventoryCalls: () => inventoryCalls };
}

function dependencies(config: QuestionOwnerConfigResolution, driver?: QuestionPresentationDriver): AskUserQuestionDependencies {
	return {
		resolveAgentHome: () => "/profiles/test",
		readOwnerConfig: async () => config,
		createPresentationDriver: () => driver ?? { present: async () => { throw new Error("test driver was not supplied"); } },
	};
}

function rpcDependencies(config: QuestionOwnerConfigResolution, selectedModes: unknown[], correlations: string[]): AskUserQuestionDependencies {
	return {
		resolveAgentHome: () => "/profiles/test",
		readOwnerConfig: async () => config,
		createPresentationDriver: (ui, mode?: string) => {
			selectedModes.push(mode);
			const driver = createRpcQuestionPresentationDriver(ui as never);
			return { present: async (request, signal) => {
				correlations.push(request.correlationId);
				return driver.present(request, signal);
			} };
		},
	};
}

type GuidanceAwareDependencies = AskUserQuestionDependencies & {
	readGuidanceConfig: (agentHome: string) => Promise<QuestionnaireGuidance>;
};

function guidanceDependencies(
	config: QuestionOwnerConfigResolution,
	readGuidanceConfig: GuidanceAwareDependencies["readGuidanceConfig"],
	order?: string[],
): GuidanceAwareDependencies {
	return {
		resolveAgentHome: () => {
			order?.push("home");
			return "/profiles/test";
		},
		readOwnerConfig: async () => {
			order?.push("owner");
			return config;
		},
		readGuidanceConfig,
		createPresentationDriver: () => ({ present: async () => { throw new Error("test driver was not supplied"); } }),
	};
}

async function start(subject: ReturnType<typeof host>, mode: string, ui: TestUi = { custom: async () => undefined }, hasUI = mode === "tui"): Promise<void> {
	assert.equal(subject.sessionStarts.length, 1, "the factory registers one session_start handler");
	await subject.sessionStarts[0]!({ type: "session_start", reason: "startup" }, { mode, hasUI, ui });
}

async function withDefaultOwner(run: () => Promise<void>): Promise<void> {
	const fixture = await mkdtemp(join(tmpdir(), "gentle-pi-question-owner-"));
	const original = new Map(["HOME", "XDG_CONFIG_HOME", "GENTLE_PI_AGENT_HOME", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
	const agentHome = join(fixture, "agent");
	try {
		process.env.HOME = join(fixture, "home");
		process.env.XDG_CONFIG_HOME = join(fixture, "xdg");
		process.env.GENTLE_PI_AGENT_HOME = agentHome;
		process.env.PI_CODING_AGENT_DIR = agentHome;
		await mkdir(join(agentHome, "gentle-ai"), { recursive: true });
		await writeFile(join(agentHome, "gentle-ai", "question-owner.json"), JSON.stringify({ schema: "gentle-pi.question-owner/v1", owner: "gentle-pi" }));
		await run();
	} finally {
		for (const [key, value] of original) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(fixture, { recursive: true, force: true });
	}
}

test("does not register the questionnaire for legacy or disabled owners", async (t) => {
	for (const configuredOwner of ["legacy-external", "disabled"] as const) {
		for (const session of [
			{ name: "tui", mode: "tui", ui: { custom: async () => undefined }, hasUI: true },
			{ name: "rpc", mode: "rpc", ui: { select: async () => undefined, editor: async () => undefined }, hasUI: true },
		]) {
			await t.test(`${configuredOwner} ${session.name}`, async () => {
				const subject = host();
				createAskUserQuestionExtension(dependencies(owner(configuredOwner)))(subject.pi as never);
				assert.deepEqual(subject.tools, [], "factory registration is deferred until a session has a mode");
				await start(subject, session.mode, session.ui, session.hasUI);
				assert.deepEqual(subject.tools, []);
			});
		}
	}
});

test("registers the exact bounded questionnaire schema only in a TUI session", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "tui");
	assert.equal(subject.tools.length, 1);
	const tool = subject.tools[0]!;
	assert.equal(tool.name, "ask_user_question");
	assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["questions"]);
	const questions = tool.parameters.properties?.questions as { minItems?: number; maxItems?: number; items?: { properties?: Record<string, { maxLength?: number }> } };
	assert.equal(questions.minItems, 1);
	assert.equal(questions.maxItems, 4);
	assert.equal(questions.items?.properties?.header?.maxLength, 16);
	assert.equal(questions.items?.properties?.options?.maxItems, 4);
	assert.equal(questions.items?.properties?.options?.minItems, 2);
	assert.equal((questions.items?.properties?.options as { items?: { properties?: Record<string, { maxLength?: number }> } }).items?.properties?.label?.maxLength, 60);
});

test("default admitted TUI registration forwards an external-editor callback to the real driver", { concurrency: false }, async () => {
	await withDefaultOwner(async () => {
		let component: { cancel(): void; presentationOptions?: { externalEditor?: unknown } } | undefined;
		let settle!: (outcome: unknown) => void;
		const pending = new Promise<unknown>((resolve) => { settle = resolve; });
		const tui = { terminal: { rows: 24 }, requestRender() {} };
		const ui: TestUi = {
			custom(factory: unknown) {
				component = (factory as (tui: typeof tui, theme: { fg(color: string, text: string): string; bold(text: string): string }, keybindings: object, done: (outcome: unknown) => void) => typeof component)(
					tui,
					{ fg: (_color, text) => text, bold: (text) => text },
					{},
					settle,
				);
				return pending;
			},
		};
		const subject = host();
		createAskUserQuestionExtension()(subject.pi as never);
		await start(subject, "tui", ui);
		const execution = subject.tools[0]!.execute("default-external-editor", { questions: [legacyQuestion()] }, new AbortController().signal, undefined, { mode: "tui", ui });
		try {
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(typeof component?.presentationOptions?.externalEditor, "function");
		} finally {
			component?.cancel();
			await execution;
		}
	});
});

test("registers in RPC only when the owner allows it and native dialog methods are available", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "rpc", { select: async () => undefined, editor: async () => undefined }, true);
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"]);
});

test("does not register for RPC without both native dialog methods or for hasUI false", async (t) => {
	const cases: Array<{ name: string; ui: TestUi; hasUI: boolean }> = [
		{ name: "missing select", ui: { editor: async () => undefined }, hasUI: true },
		{ name: "missing editor", ui: { select: async () => undefined }, hasUI: true },
		{ name: "no UI", ui: { select: async () => undefined, editor: async () => undefined }, hasUI: false },
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const subject = host();
			createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
			await start(subject, "rpc", scenario.ui, scenario.hasUI);
			assert.deepEqual(subject.tools, []);
		});
	}
});

test("never registers for print or json sessions", async () => {
	for (const mode of ["print", "json"]) {
		const subject = host();
		createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
		await start(subject, mode, { select: async () => undefined, editor: async () => undefined }, false);
		assert.deepEqual(subject.tools, [], mode);
	}
});

test("does not displace an incumbent public tool name", async () => {
	const subject = host(["ask_user_question"]);
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "tui");
	assert.equal(subject.inventoryCalls(), 1, "inventory is consulted after the host binds the session");
	assert.deepEqual(subject.tools, []);
});

test("makes repeated TUI session starts idempotent", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "tui");
	await start(subject, "tui");
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"]);
});

test("correlates and aborts one TUI request, balances status, and rejects concurrent execution", async () => {
	let captured: { correlationId: string; signal: AbortSignal | undefined } | undefined;
	let finish: (() => void) | undefined;
	const driver: QuestionPresentationDriver = { present: (request, signal) => new Promise((resolve) => {
		captured = { correlationId: request.correlationId, signal };
		finish = () => resolve({ correlationId: request.correlationId, cancelled: true, answers: [] });
	}) };
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi"), driver))(subject.pi as never);
	await start(subject, "tui");
	const tool = subject.tools[0]!;
	const signal = new AbortController().signal;
	const context = { mode: "tui", ui: { custom: async () => undefined } };
	const first = tool.execute("call-42", { questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }] }] }, signal, undefined, context);
	await assert.rejects(() => tool.execute("call-43", { questions: [] }, signal, undefined, context), /already active/i);
	assert.deepEqual(captured, { correlationId: "call-42", signal });
	finish?.();
	await first;
	assert.deepEqual(subject.events, [
		{
			channel: "rpiv:ask-user:prompt",
			payload: {
				questions: [{
					question: "Proceed?",
					header: "Proceed",
					multiSelect: false,
					options: [
						{ label: "Yes", description: "Continue", hasPreview: false },
						{ label: "No", description: "Stop", hasPreview: false },
					],
				}],
			},
		},
		{ channel: "rpiv:ask-user:blocked", payload: { active: true } },
		{ channel: "rpiv:ask-user:blocked", payload: { active: false } },
	]);
});

test("emits the legacy prompt before one blocked bracket and releases before each outer completion", async () => {
	const valid = eventContract.sourceEventContractOracle.valid;
	const [question] = valid.input.questions;
	assert.ok(question, "the committed legacy event oracle supplies one valid question");
	const pendingEvents = valid.pendingEvents.map((event) => ({
		...event,
		payload: event.payload === "promptPayload" ? valid.promptPayload : event.payload,
	}));
	const cases = [
		{
			name: "selected",
			action: { kind: "resolve" as const, outcome: { cancelled: false, answers: [{ questionIndex: 0, question: question.question, kind: "option", answer: question.options[0]!.label }] } },
		},
		{ name: "cancelled", action: { kind: "resolve" as const, outcome: { cancelled: true, answers: [] } } },
		{ name: "driver rejection", action: { kind: "reject" as const, error: new Error("scripted-dialog-rejection") } },
	];

	for (const scenario of cases) {
		let entered!: () => void;
		const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
		let release!: (action: (typeof cases)[number]["action"]) => void;
		const driver: QuestionPresentationDriver = { present: (request) => new Promise((resolve, reject) => {
			entered();
			release = (action) => {
				if (action.kind === "reject") reject(action.error);
				else resolve({ correlationId: request.correlationId, ...action.outcome });
			};
		}) };
		const subject = host();
		createAskUserQuestionExtension(dependencies(owner("gentle-pi"), driver))(subject.pi as never);
		await start(subject, "tui");
		const execution = subject.tools[0]!.execute(`legacy-event-${scenario.name}`, valid.input, new AbortController().signal, undefined, { mode: "tui", ui: { custom: async () => undefined } });
		let eventCountAtOuterCompletion = -1;
		const completionMarker = execution.then(
			() => { eventCountAtOuterCompletion = subject.events.length; },
			() => { eventCountAtOuterCompletion = subject.events.length; },
		);

		await enteredGate;
		assert.deepEqual(subject.events, pendingEvents, `${scenario.name}: only prompt then active blocking is observable while pending`);
		release(scenario.action);
		if (scenario.action.kind === "reject") await assert.rejects(() => execution, /scripted-dialog-rejection/);
		else await execution;
		await completionMarker;
		assert.deepEqual(subject.events, [...pendingEvents, valid.releaseEvent], `${scenario.name}: exactly one release follows the prompt bracket`);
		assert.equal(eventCountAtOuterCompletion, subject.events.length, `${scenario.name}: release precedes the caller-visible completion`);
	}
});

test("returns the observed no_questions envelope without emitting questionnaire events", async () => {
	const invalid = eventContract.observedRegistrarNoQuestionsEnvelope;
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => { throw new Error("invalid input reached the presentation driver"); } }))(subject.pi as never);
	await start(subject, "tui");
	const result = await subject.tools[0]!.execute("legacy-event-invalid", invalid.input, new AbortController().signal, undefined, { mode: "tui", ui: { custom: async () => undefined } });
	assert.deepEqual(result, invalid.errorEnvelope);
	assert.deepEqual(subject.events, invalid.events);
});

const legacyOptions = [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }];
const legacyQuestion = (question = "Proceed?", header = "Proceed", options = legacyOptions) => ({ question, header, options });
const legacyErrorCases = [
	{ code: "no_questions", message: "At least one question is required", input: { questions: [] } },
	{ code: "too_many_questions", message: "At most 4 questions are allowed per invocation", input: { questions: Array.from({ length: 5 }, (_, index) => legacyQuestion(`Question ${index}?`)) } },
	{ code: "duplicate_question", message: "Question text must be unique within an invocation", input: { questions: [legacyQuestion(), legacyQuestion("Proceed?", "Again")] } },
	{ code: "empty_options", message: "Each question requires at least 2 options", input: { questions: [legacyQuestion("Proceed?", "Proceed", [legacyOptions[0]!])] } },
	{ code: "reserved_label", message: "Option label is reserved (Other, Type something., Next)", input: { questions: [legacyQuestion("Proceed?", "Proceed", [{ label: "Next", description: "Reserved" }, legacyOptions[1]!])] } },
	{ code: "duplicate_option_label", message: "Option labels must be unique within a question", input: { questions: [legacyQuestion("Proceed?", "Proceed", [legacyOptions[0]!, { label: "Yes", description: "Repeated" }])] } },
] as const;

function legacyErrorEnvelope(code: string, message: string) {
	return { content: [{ type: "text", text: `Error: ${message}` }], details: { answers: [], cancelled: true, error: code } };
}

// U1 observed these validator inputs at legacy runtime; order is source-derived, not extra runtime evidence.
test("returns legacy validation envelopes without events or presentation", async (t) => {
	for (const legacy of legacyErrorCases) {
		await t.test(legacy.code, async () => {
			let driverCalls = 0;
			const subject = host();
			createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => {
				driverCalls++;
				throw new Error("legacy-invalid input reached the presentation driver");
			} }))(subject.pi as never);
			await start(subject, "tui");
			const result = await subject.tools[0]!.execute(`legacy-${legacy.code}`, legacy.input, new AbortController().signal, undefined, { mode: "tui", ui: { custom: async () => undefined } });
			assert.deepEqual(result, legacyErrorEnvelope(legacy.code, legacy.message));
			assert.equal(driverCalls, 0);
			assert.deepEqual(subject.events, []);
		});
	}
});

test("returns the observed no_ui envelope from a non-TUI execution without registering RPC", async () => {
	let driverCalls = 0;
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => {
		driverCalls++;
		throw new Error("no_ui input reached the presentation driver");
	} }))(subject.pi as never);
	await start(subject, "tui");
	const result = await subject.tools[0]!.execute("legacy-no-ui", { questions: [legacyQuestion()] }, new AbortController().signal, undefined, { mode: "rpc", ui: { custom: async () => undefined } });
	assert.deepEqual(result, legacyErrorEnvelope("no_ui", "UI not available (running in non-interactive mode)"));
	assert.equal(driverCalls, 0);
	assert.deepEqual(subject.events, []);
});

const canonicalFallbackCases = [
	{ name: "header length", input: { questions: [legacyQuestion("Proceed?", "x".repeat(17))] }, message: "Question limits are invalid" },
	{ name: "too many options", input: { questions: [legacyQuestion("Proceed?", "Proceed", [...legacyOptions, { label: "Maybe", description: "Later" }, { label: "Never", description: "No" }, { label: "Extra", description: "Fallback" }])] }, message: "Question limits are invalid" },
	{ name: "missing header", input: { questions: [{ question: "Proceed?", options: legacyOptions }] }, message: "Question text and header must be strings" },
] as const;

test("keeps canonical-only invalid inputs on the invalid_input fallback", async (t) => {
	for (const fallback of canonicalFallbackCases) {
		await t.test(fallback.name, async () => {
			let driverCalls = 0;
			const subject = host();
			createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => {
				driverCalls++;
				throw new Error("canonical fallback reached the presentation driver");
			} }))(subject.pi as never);
			await start(subject, "tui");
			const result = await subject.tools[0]!.execute(`canonical-${fallback.name}`, fallback.input, new AbortController().signal, undefined, { mode: "tui", ui: { custom: async () => undefined } });
			assert.deepEqual(result, legacyErrorEnvelope("invalid_input", fallback.message));
			assert.equal(driverCalls, 0);
			assert.deepEqual(subject.events, []);
		});
	}
});

test("keeps sparse direct inputs on the canonical invalid_input fallback", async (t) => {
	const sparseQuestions = new Array(1);
	const sparseOptions = new Array(2);
	const sparseCases = [
		{ name: "questions hole", input: { questions: sparseQuestions }, message: "Question text and header must be strings", hole: sparseQuestions },
		{ name: "options hole", input: { questions: [{ question: "Proceed?", header: "Proceed", options: sparseOptions }] }, message: "Option fields are invalid", hole: sparseOptions },
	];
	for (const sparse of sparseCases) {
		await t.test(sparse.name, async () => {
			assert.equal(0 in sparse.hole, false, "the reproducer must retain an array hole");
			let driverCalls = 0;
			const subject = host();
			createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => {
				driverCalls++;
				throw new Error("sparse input reached the presentation driver");
			} }))(subject.pi as never);
			await start(subject, "tui");
			const result = await subject.tools[0]!.execute(`sparse-${sparse.name}`, sparse.input, new AbortController().signal, undefined, { mode: "tui", ui: { custom: async () => undefined } });
			assert.deepEqual(result, legacyErrorEnvelope("invalid_input", sparse.message));
			assert.equal(driverCalls, 0);
			assert.deepEqual(subject.events, []);
		});
	}
});

test("routes an RPC call through native select and formats the correlated answer", async () => {
	let begin!: () => void;
	const begun = new Promise<void>((resolve) => { begin = resolve; });
	let chooseAction!: (value: string) => void;
	const action = new Promise<string>((resolve) => { chooseAction = resolve; });
	const calls: Array<{ title: string; options: string[] }> = [];
	const ui: TestUi = {
		custom: async () => undefined,
		select: async (title, options) => {
			calls.push({ title, options });
			if (calls.length === 1) {
				begin();
				return action;
			}
			return calls.length === 2 ? "Yes" : "Submit";
		},
		editor: async () => undefined,
	};
	const selectedModes: unknown[] = [];
	const correlations: string[] = [];
	const subject = host();
	createAskUserQuestionExtension(rpcDependencies(owner("gentle-pi"), selectedModes, correlations))(subject.pi as never);
	await start(subject, "rpc", ui, true);
	const execution = subject.tools[0]!.execute("rpc-call-42", { questions: [legacyQuestion()] }, new AbortController().signal, undefined, { mode: "rpc", hasUI: true, ui });
	let eventsAtCompletion = -1;
	const completion = execution.then(() => { eventsAtCompletion = subject.events.length; });
	await begun;
	assert.deepEqual(subject.events, [
		{ channel: "rpiv:ask-user:prompt", payload: { questions: [{ question: "Proceed?", header: "Proceed", multiSelect: false, options: [{ label: "Yes", description: "Continue", hasPreview: false }, { label: "No", description: "Stop", hasPreview: false }] }] } },
		{ channel: "rpiv:ask-user:blocked", payload: { active: true } },
	]);
	chooseAction("Choose an option");
	const result = await execution;
	await completion;
	assert.deepEqual(selectedModes, ["rpc"]);
	assert.deepEqual(correlations, ["rpc-call-42"]);
	assert.deepEqual(calls.map((call) => call.options), [
		["Choose an option", "Use custom text", "Skip", "Submit", "Submit partial", "Cancel"],
		["Yes", "No"],
		["Choose an option", "Use custom text", "Skip", "Submit", "Submit partial", "Cancel"],
	]);
	assert.deepEqual(result, {
		content: [{ type: "text", text: "User has answered your questions: \"Proceed?\"=\"Yes\". You can now continue with the user's answers in mind." }],
		details: { answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Yes" }], cancelled: false },
	});
	assert.deepEqual(subject.events, [
		{ channel: "rpiv:ask-user:prompt", payload: { questions: [{ question: "Proceed?", header: "Proceed", multiSelect: false, options: [{ label: "Yes", description: "Continue", hasPreview: false }, { label: "No", description: "Stop", hasPreview: false }] }] } },
		{ channel: "rpiv:ask-user:blocked", payload: { active: true } },
		{ channel: "rpiv:ask-user:blocked", payload: { active: false } },
	]);
	assert.equal(eventsAtCompletion, subject.events.length, "the release is observable before RPC execution settles");
});

test("passes the admitted localizer to the real RPC driver without translating authored events", async () => {
	const translations: Record<string, string> = {
		"Choose an option": "Eine Option wählen",
		"Use custom text": "Eigenen Text verwenden",
		"Skip": "Überspringen",
		"Submit": "Absenden",
		"Submit partial": "Teilweise absenden",
		"Cancel": "Abbrechen",
	};
	const providedLocalizer: QuestionnaireLocalizer = (_key, fallback) => translations[fallback] ?? fallback;
	let receivedLocalizer: QuestionnaireLocalizer | undefined;
	const uiCalls: Array<{ title: string; options: string[] }> = [];
	const ui: TestUi = {
		select: async (title, options) => {
			uiCalls.push({ title, options });
			return uiCalls.length === 1 ? "Eine Option wählen" : uiCalls.length === 2 ? "Yes" : "Absenden";
		},
		editor: async () => undefined,
	};
	const subject = host();
	createAskUserQuestionExtension({
		resolveAgentHome: () => "/profiles/test",
		readOwnerConfig: async () => owner("gentle-pi"),
		createLocalizer: async () => providedLocalizer,
		createPresentationDriver: (driverUi, mode, localize) => {
			assert.equal(mode, "rpc");
			receivedLocalizer = localize;
			return createLocalizedRpcDriver(driverUi as never, localize);
		},
	})(subject.pi as never);
	await start(subject, "rpc", ui, true);
	const result = await subject.tools[0]!.execute("rpc-localized", { questions: [legacyQuestion()] }, new AbortController().signal, undefined, { mode: "rpc", hasUI: true, ui });

	assert.equal(receivedLocalizer, providedLocalizer);
	assert.deepEqual(uiCalls.map((call) => call.options), [
		["Eine Option wählen", "Eigenen Text verwenden", "Überspringen", "Absenden", "Teilweise absenden", "Abbrechen"],
		["Yes", "No"],
		["Eine Option wählen", "Eigenen Text verwenden", "Überspringen", "Absenden", "Teilweise absenden", "Abbrechen"],
	]);
	assert.deepEqual(result, {
		content: [{ type: "text", text: "User has answered your questions: \"Proceed?\"=\"Yes\". You can now continue with the user's answers in mind." }],
		details: { answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Yes" }], cancelled: false },
	});
	assert.deepEqual(subject.events[0], { channel: "rpiv:ask-user:prompt", payload: { questions: [{ question: "Proceed?", header: "Proceed", multiSelect: false, options: [{ label: "Yes", description: "Continue", hasPreview: false }, { label: "No", description: "Stop", hasPreview: false }] }] } });
});

test("returns no_questions for malformed RPC input without events or presentation", async () => {
	let driverCalls = 0;
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => {
		driverCalls++;
		throw new Error("malformed RPC input reached the presentation driver");
	} }))(subject.pi as never);
	const ui: TestUi = { select: async () => undefined, editor: async () => undefined };
	await start(subject, "rpc", ui, true);
	const result = await subject.tools[0]!.execute("rpc-invalid", { questions: [] }, new AbortController().signal, undefined, { mode: "rpc", hasUI: true, ui });
	assert.deepEqual(result, legacyErrorEnvelope("no_questions", "At least one question is required"));
	assert.equal(driverCalls, 0);
	assert.deepEqual(subject.events, []);
});

test("returns no_ui when direct RPC execution lacks native dialog methods", async () => {
	let driverCalls = 0;
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => { driverCalls++; throw new Error("missing-capability RPC reached the presentation driver"); } }))(subject.pi as never);
	await start(subject, "tui");
	const result = await subject.tools[0]!.execute("rpc-missing-methods", { questions: [legacyQuestion()] }, new AbortController().signal, undefined, { mode: "rpc", hasUI: true, ui: { custom: async () => undefined } });
	assert.deepEqual(result, legacyErrorEnvelope("no_ui", "UI not available (running in non-interactive mode)"));
	assert.equal(driverCalls, 0);
	assert.deepEqual(subject.events, []);
});

test("releases the RPC blocked bracket before surfacing a native dialog rejection", async () => {
	const rejection = new Error("native-rpc-rejection");
	const ui: TestUi = { select: async () => { throw rejection; }, editor: async () => undefined };
	const selectedModes: unknown[] = [];
	const correlations: string[] = [];
	const subject = host();
	createAskUserQuestionExtension(rpcDependencies(owner("gentle-pi"), selectedModes, correlations))(subject.pi as never);
	await start(subject, "rpc", ui, true);
	const execution = subject.tools[0]!.execute("rpc-reject", { questions: [legacyQuestion()] }, new AbortController().signal, undefined, { mode: "rpc", hasUI: true, ui });
	let eventsAtCompletion = -1;
	const completion = execution.then(
		() => { eventsAtCompletion = subject.events.length; },
		() => { eventsAtCompletion = subject.events.length; },
	);
	await assert.rejects(() => execution, rejection);
	await completion;
	assert.deepEqual(selectedModes, ["rpc"]);
	assert.deepEqual(correlations, ["rpc-reject"]);
	assert.deepEqual(subject.events, [
		{ channel: "rpiv:ask-user:prompt", payload: { questions: [{ question: "Proceed?", header: "Proceed", multiSelect: false, options: [{ label: "Yes", description: "Continue", hasPreview: false }, { label: "No", description: "Stop", hasPreview: false }] }] } },
		{ channel: "rpiv:ask-user:blocked", payload: { active: true } },
		{ channel: "rpiv:ask-user:blocked", payload: { active: false } },
	]);
	assert.equal(eventsAtCompletion, subject.events.length, "the release is observable before the rejected RPC execution settles");
});

test("does not displace an incumbent RPC tool", async () => {
	const subject = host(["ask_user_question"]);
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "rpc", { select: async () => undefined, editor: async () => undefined }, true);
	assert.equal(subject.inventoryCalls(), 1);
	assert.deepEqual(subject.tools, []);
});

test("makes repeated eligible RPC session starts idempotent", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	const ui: TestUi = { select: async () => undefined, editor: async () => undefined };
	await start(subject, "rpc", ui, true);
	await start(subject, "rpc", ui, true);
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"]);
});

test("reads first-party guidance after owner admission and incumbent inventory, preserving configured metadata in TUI and RPC", async (t) => {
	for (const session of [
		{ name: "TUI", mode: "tui", ui: { custom: async () => undefined }, hasUI: true },
		{ name: "RPC", mode: "rpc", ui: { select: async () => undefined, editor: async () => undefined }, hasUI: true },
	]) {
		await t.test(session.name, async () => {
			const order: string[] = [];
			const subject = host();
			const originalInventory = subject.pi.getAllTools;
			subject.pi.getAllTools = () => {
				order.push("inventory");
				return originalInventory();
			};
			const configured = {
				description: "  configured description  ",
				promptSnippet: "  configured snippet  ",
				promptGuidelines: ["  first guideline  ", "  second guideline  "],
			};
			createAskUserQuestionExtension(guidanceDependencies(owner("gentle-pi"), async (agentHome) => {
				order.push(`guidance:${agentHome}`);
				return configured;
			}, order))(subject.pi as never);
			await start(subject, session.mode, session.ui, session.hasUI);
			assert.deepEqual(order, ["home", "owner", "inventory", "guidance:/profiles/test"]);
			assert.deepEqual(subject.tools.map((tool) => ({
				description: tool.description,
				promptSnippet: tool.promptSnippet,
				promptGuidelines: tool.promptGuidelines,
			})), [configured]);
		});
	}
});

test("uses incumbent metadata when optional first-party guidance is absent or unreadable", async (t) => {
	for (const scenario of [
		{ name: "absent", readGuidanceConfig: async () => ({}) },
		{ name: "reader throws", readGuidanceConfig: async () => { throw new Error("optional guidance is unreadable"); } },
	]) {
		await t.test(scenario.name, async () => {
			let reads = 0;
			const subject = host();
			createAskUserQuestionExtension(guidanceDependencies(owner("gentle-pi"), async (agentHome) => {
				reads++;
				assert.equal(agentHome, "/profiles/test");
				return scenario.readGuidanceConfig();
			}))(subject.pi as never);
			await start(subject, "tui");
			assert.equal(reads, 1);
			const tool = subject.tools[0]!;
			assert.equal(tool.description, "Ask the user one to four structured questions in the interactive TUI.");
			assert.equal(Object.hasOwn(tool, "promptSnippet"), false);
			assert.equal(Object.hasOwn(tool, "promptGuidelines"), false);
		});
	}
});

test("does not read optional guidance before owner admission, after an incumbent, or for unsupported modes", async (t) => {
	const cases: Array<{ name: string; config: QuestionOwnerConfigResolution; inventory?: string[]; mode: string; ui: TestUi; hasUI: boolean; expectedOrder: string[] }> = [
		{ name: "owner denied", config: owner("disabled"), mode: "tui", ui: { custom: async () => undefined }, hasUI: true, expectedOrder: ["home", "owner"] },
		{ name: "incumbent", config: owner("gentle-pi"), inventory: ["ask_user_question"], mode: "tui", ui: { custom: async () => undefined }, hasUI: true, expectedOrder: ["home", "owner", "inventory"] },
		{ name: "print", config: owner("gentle-pi"), mode: "print", ui: {}, hasUI: false, expectedOrder: [] },
		{ name: "JSON", config: owner("gentle-pi"), mode: "json", ui: {}, hasUI: false, expectedOrder: [] },
		{ name: "RPC without native dialogs", config: owner("gentle-pi"), mode: "rpc", ui: { select: async () => undefined }, hasUI: true, expectedOrder: [] },
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const order: string[] = [];
			const subject = host(scenario.inventory);
			const originalInventory = subject.pi.getAllTools;
			subject.pi.getAllTools = () => {
				order.push("inventory");
				return originalInventory();
			};
			let reads = 0;
			createAskUserQuestionExtension(guidanceDependencies(scenario.config, async () => {
				reads++;
				order.push("guidance");
				return {};
			}, order))(subject.pi as never);
			await start(subject, scenario.mode, scenario.ui, scenario.hasUI);
			assert.equal(reads, 0);
			assert.deepEqual(order, scenario.expectedOrder);
		});
	}
});
