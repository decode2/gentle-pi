import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createAskUserQuestionExtension, type AskUserQuestionDependencies } from "../extensions/ask-user-question.ts";
import { KeybindingsManager as TuiKeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import type { QuestionOwnerConfigResolution } from "../lib/questions/owner-config.ts";
import type { QuestionnaireGuidance } from "../lib/questions/guidance-config.ts";
import type { QuestionPresentationDriver, RawQuestionnaireOutcome } from "../lib/questions/contract.ts";
import type { QuestionnaireLocalizer } from "../lib/questions/localization.ts";
import { createRpcQuestionPresentationDriver } from "../lib/questions/rpc-presentation-driver.ts";
import { createTuiQuestionPresentationDriver } from "../lib/questions/tui-presentation-driver.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

type LocalizedRpcDriverFactory = (
	ui: Parameters<typeof createRpcQuestionPresentationDriver>[0],
	localize?: QuestionnaireLocalizer,
) => QuestionPresentationDriver;

// Keep the local test seam aligned with the public driver factory.
const createLocalizedRpcDriver = createRpcQuestionPresentationDriver as LocalizedRpcDriverFactory;

type TestUi = {
	custom?: unknown;
	select?: ExtensionUIContext["select"];
	input?: ExtensionUIContext["input"];
	editor?: ExtensionUIContext["editor"];
};
type SessionHandler = (event: unknown, ctx: { mode: string; hasUI?: boolean; ui: TestUi }) => Promise<void> | void;

function createTestKeybindings(): TuiKeybindingsManager {
	return new TuiKeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
	});
}

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

type ScenarioOutcome = Omit<RawQuestionnaireOutcome, "correlationId">;
type ScenarioAction =
	| { kind: "resolve"; outcome: ScenarioOutcome }
	| { kind: "reject"; error: Error };

function schemaObject(value: unknown, label: string): Record<string, unknown> {
	assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
	return value as Record<string, unknown>;
}

function schemaDescription(value: unknown, label: string): string {
	const description = schemaObject(value, label).description;
	if (typeof description !== "string") assert.fail(`${label} must have a description`);
	assert.ok(description.trim().length > 0, `${label} description must not be empty`);
	return description.toLowerCase();
}

function requiredText(value: string | undefined, label: string): string {
	if (typeof value !== "string") assert.fail(`${label} must be a string`);
	assert.ok(value.trim().length > 0, `${label} must not be empty`);
	return value;
}

function assertDefaultModelMetadata(tool: RegisteredTool): void {
	const description = requiredText(tool.description, "default description");
	const snippet = requiredText(tool.promptSnippet, "default prompt snippet");
	const guidelines = tool.promptGuidelines;
	if (guidelines === undefined || guidelines.length === 0) assert.fail("default prompt guidelines must be non-empty");
	for (const [index, guideline] of guidelines.entries()) {
		assert.ok(guideline.trim().length > 0, `default guideline ${index} must not be empty`);
		assert.ok(guideline.includes("ask_user_question"), `default guideline ${index} names the SDK tool`);
	}

	const metadata = [description, snippet, ...guidelines].join("\n").toLowerCase();
	for (const concept of ["requirements", "decision", "preferences"]) assert.match(metadata, new RegExp(`\\b${concept}\\b`));
	assert.match(metadata, /\btrade[- ]?offs?\b/);
	for (const pattern of [
		/\b(?:1|one)\s*(?:-|–|to|through)\s*(?:4|four)\b|\bup to (?:4|four)\b/,
		/\b(?:2|two)\s*(?:-|–|to|through)\s*(?:4|four)\b/,
		/\b(?:automatic(?:ally)?|built[- ]in)\b/,
		/\bcustom\b/,
		/\b(?:free[- ]?(?:response|form)|custom text)\b/,
		/\bcancell?ation\b|\bcancel\b/,
	]) assert.match(metadata, pattern);
	if (/\b(?:tui|terminal)\b/.test(metadata)) {
		assert.match(metadata, /\brpc\b/, "TUI/terminal metadata must also cover RPC");
		assert.doesNotMatch(metadata, /\b(?:tui|terminal)\b[^.!?\n]{0,80}\b(?:only|exclusive(?:ly)?)\b|\b(?:only|exclusive(?:ly)?)\b[^.!?\n]{0,80}\b(?:tui|terminal)\b/);
	}
	assert.doesNotMatch(metadata, /\b(?:default\s+key|default\s+shortcut|collapsekey)\b/);
	assert.doesNotMatch(metadata, /\b(?:always|guarantee(?:d)?|must|required)\b[^.!?\n]{0,100}\bside[- ]by[- ]side\b|\bside[- ]by[- ]side\b[^.!?\n]{0,100}\b(?:always|guarantee(?:d)?|must|required)\b/);
	assert.doesNotMatch(metadata, /\b(?:ask\s+)?exactly\s+(?:4|four)\s+questions?\b|\b(?:must|always|required to)\s+ask\s+(?:4|four)\s+questions?\b/);

	for (const pattern of [/\bask\b/, /\bbefore\b/, /\bguess/]) assert.match(snippet.toLowerCase(), pattern);
	assert.ok(snippet.trim().split(/\s+/).length <= 12, "default prompt snippet stays concise");
	for (const term of ["distinct", "descriptions?", "header", "label", "16", "60", "multiselect", "multiple", "valid"]) {
		assert.match(metadata, new RegExp(`\\b${term}\\b`));
	}
	for (const reserved of ["other", "type something.", "next"]) assert.ok(metadata.includes(reserved), `default guidance names reserved label ${reserved}`);
	assert.match(metadata, /\b(?:never|do not|don't)\b/);
	assert.match(metadata, /\bauthor/);

	const previewGuideline = requiredText(guidelines.find((guideline) => /\bpreview\b/i.test(guideline)), "preview guidance").toLowerCase();
	for (const pattern of [/markdown/, /\bsingle[- ]select\b/, /artifact/, /comparison/]) assert.match(previewGuideline, pattern);
	assert.match(previewGuideline, /\bonly\b/);
	const recommendationGuideline = requiredText(guidelines.find((guideline) => /recommended/i.test(guideline)), "recommendation guidance").toLowerCase();
	for (const pattern of [/\bfirst\b/, /\(recommended\)/, /\b(?:appropriate|when it makes sense)\b/]) assert.match(recommendationGuideline, pattern);
	const batchingGuideline = guidelines.find((guideline) => /\bbatch/i.test(guideline));
	if (batchingGuideline !== undefined) {
		const batchingText = batchingGuideline.toLowerCase();
		for (const pattern of [/\bpreference/, /\b(?:don't|do not|avoid|never)\b/]) assert.match(batchingText, pattern);
	}
}

function owner(ownerName: "gentle-pi" | "legacy-external" | "disabled"): QuestionOwnerConfigResolution {
	return ownerName === "gentle-pi"
		? { allowRegistration: true, owner: "gentle-pi", reason: "configured_gentle_pi", path: "/profiles/test/gentle-ai/question-owner.json" }
		: { allowRegistration: false, owner: ownerName, reason: ownerName === "disabled" ? "configured_disabled" : "configured_external", path: "/profiles/test/gentle-ai/question-owner.json" };
}

function host(inventory: string[] = [], initialActiveTools: string[] = inventory) {
	const sessionStarts: SessionHandler[] = [];
	const beforeAgentStarts: SessionHandler[] = [];
	const tools: RegisteredTool[] = [];
	const events: EventRecord[] = [];
	const activeTools = [...initialActiveTools];
	const activeToolWrites: string[][] = [];
	let inventoryCalls = 0;
	const pi = {
		on(event: string, handler: SessionHandler) {
			if (event === "session_start") sessionStarts.push(handler);
			else if (event === "before_agent_start") beforeAgentStarts.push(handler);
		},
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
			if (!activeTools.includes(tool.name)) activeTools.push(tool.name);
		},
		getAllTools() { inventoryCalls++; return inventory.map((name) => ({ name })); },
		getActiveTools() { return [...activeTools]; },
		setActiveTools(names: string[]) {
			activeToolWrites.push([...names]);
			activeTools.splice(0, activeTools.length, ...names);
		},
		events: { emit(channel: string, payload: unknown) { events.push({ channel, payload }); } },
	};
	return {
		pi,
		sessionStarts,
		beforeAgentStarts,
		tools,
		events,
		activeTools: () => [...activeTools],
		activeToolWrites: () => activeToolWrites.map((names) => [...names]),
		inventoryCalls: () => inventoryCalls,
	};
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

const supportedQuestionnaireSessions = [
	{ name: "TUI", mode: "tui", ui: { custom: async () => undefined }, hasUI: true },
	{ name: "RPC", mode: "rpc", ui: { select: async () => undefined, editor: async () => undefined }, hasUI: true },
];

async function start(subject: ReturnType<typeof host>, mode: string, ui: TestUi = { custom: async () => undefined }, hasUI = mode === "tui"): Promise<void> {
	assert.equal(subject.sessionStarts.length, 1, "the factory registers one session_start handler");
	await subject.sessionStarts[0]!({ type: "session_start", reason: "startup" }, { mode, hasUI, ui });
}

async function startWithoutHasUI(subject: ReturnType<typeof host>, mode = "tui", ui: TestUi = { custom: async () => undefined }): Promise<void> {
	assert.equal(subject.sessionStarts.length, 1, "the factory registers one session_start handler");
	await subject.sessionStarts[0]!({ type: "session_start", reason: "startup" }, { mode, ui });
}

async function beforeAgentStart(subject: ReturnType<typeof host>, mode: string, ui: TestUi, hasUI = mode === "tui"): Promise<void> {
	assert.equal(subject.beforeAgentStarts.length, 1, "the factory registers one before_agent_start handler");
	await subject.beforeAgentStarts[0]!({ type: "before_agent_start" }, { mode, hasUI, ui });
}

async function beforeAgentStartWithoutHasUI(subject: ReturnType<typeof host>, ui: TestUi = { custom: async () => undefined }): Promise<void> {
	assert.equal(subject.beforeAgentStarts.length, 1, "the factory registers one before_agent_start handler");
	await subject.beforeAgentStarts[0]!({ type: "before_agent_start" }, { mode: "tui", ui });
}

async function withDefaultOwner(run: (agentHome: string) => Promise<void>): Promise<void> {
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
		await run(agentHome);
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

test("registers the exact bounded questionnaire schema with model-facing field descriptions", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "tui");
	assert.equal(subject.tools.length, 1);
	const tool = subject.tools[0]!;
	assert.equal(tool.name, "ask_user_question");
	const parameters = schemaObject(tool.parameters, "parameters");
	assert.equal(parameters.additionalProperties, false);
	assert.deepEqual(parameters.required, ["questions"]);
	const parameterProperties = schemaObject(parameters.properties, "parameter properties");
	assert.deepEqual(Object.keys(parameterProperties).sort(), ["questions"]);
	const questions = schemaObject(parameterProperties.questions, "questions");
	assert.equal(questions.minItems, 1);
	assert.equal(questions.maxItems, 4);
	schemaDescription(questions, "questions");

	const questionSchema = schemaObject(questions.items, "question items");
	assert.equal(questionSchema.additionalProperties, false);
	assert.deepEqual(questionSchema.required, ["question", "header", "options"]);
	const questionProperties = schemaObject(questionSchema.properties, "question properties");
	assert.deepEqual(Object.keys(questionProperties).sort(), ["header", "multiSelect", "options", "question"]);
	schemaDescription(questionProperties.question, "question");
	assert.match(schemaDescription(questionProperties.header, "header"), /\b(?:header|title)\b/);
	assert.equal(schemaObject(questionProperties.header, "header").maxLength, 16);
	schemaDescription(questionProperties.options, "options");
	const options = schemaObject(questionProperties.options, "options");
	assert.equal(options.maxItems, 4);
	assert.equal(options.minItems, 2);

	const optionSchema = schemaObject(options.items, "option items");
	assert.equal(optionSchema.additionalProperties, false);
	assert.deepEqual(optionSchema.required, ["label", "description"]);
	const optionProperties = schemaObject(optionSchema.properties, "option properties");
	assert.deepEqual(Object.keys(optionProperties).sort(), ["description", "label", "preview"]);
	schemaDescription(optionProperties.label, "label");
	assert.equal(schemaObject(optionProperties.label, "label").maxLength, 60);
	schemaDescription(optionProperties.description, "description");
	const previewDescription = schemaDescription(optionProperties.preview, "preview");
	for (const pattern of [/\bmarkdown\b/, /\bpreview\b/, /\b(?:single[- ]select)\b/, /\bartifact\b/, /\bcomparison\b/]) assert.match(previewDescription, pattern);
	const multiSelectDescription = schemaDescription(questionProperties.multiSelect, "multiSelect");
	for (const pattern of [/\bmultiple\b/, /\bvalid\b/]) assert.match(multiSelectDescription, pattern);
});

test("default admitted TUI registration forwards an external-editor callback to the real driver", { concurrency: false }, async () => {
	await withDefaultOwner(async () => {
		let component: { cancel(): void; presentationOptions?: { externalEditor?: unknown } } | undefined;
		let settle!: (outcome: unknown) => void;
		const pending = new Promise<unknown>((resolve) => { settle = resolve; });
		const tui = { terminal: { rows: 24 }, requestRender() {} };
		const ui: TestUi = {
			custom(factory: unknown) {
				component = (factory as (tuiValue: typeof tui, theme: { fg(color: string, text: string): string; bold(text: string): string }, keybindings: object, done: (outcome: unknown) => void) => typeof component)(
					tui,
					{ fg: (_color, text) => text, bold: (text) => text },
					createTestKeybindings(),
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

test("registers in RPC only when the owner allows it and select plus editor or input support are available", async (t) => {
	const cases: Array<{ name: string; ui: TestUi }> = [
		{ name: "editor", ui: { select: async () => undefined, editor: async () => undefined } },
		{ name: "input", ui: { select: async () => undefined, input: async () => undefined } },
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const subject = host();
			createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
			await start(subject, "rpc", scenario.ui, true);
			assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"]);
		});
	}
});

test("does not register for RPC without select plus editor or input support or for hasUI false", async (t) => {
	const cases: Array<{ name: string; ui: TestUi; hasUI: boolean }> = [
		{ name: "select only", ui: { select: async () => undefined }, hasUI: true },
		{ name: "input without select", ui: { input: async () => undefined }, hasUI: true },
		{ name: "editor without select", ui: { editor: async () => undefined }, hasUI: true },
		{ name: "missing both", ui: {}, hasUI: true },
		{ name: "no UI", ui: { select: async () => undefined, input: async () => undefined, editor: async () => undefined }, hasUI: false },
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

test("reconciles an admitted questionnaire across session starts and before-agent turns", async () => {
	const siblings = ["read", "other_tool"];
	const admitted = [...siblings, "ask_user_question"];
	const tui: TestUi = { custom: async () => undefined };
	const rpc: TestUi = { select: async () => undefined, editor: async () => undefined };
	const subject = host([], siblings);
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);

	await startWithoutHasUI(subject, "tui", tui);
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"]);
	assert.deepEqual(subject.pi.getActiveTools(), admitted);

	await start(subject, "tui", tui, false);
	assert.deepEqual(subject.pi.getActiveTools(), siblings, "explicit hasUI:false removes only the admitted tool");
	await start(subject, "tui", tui, true);
	assert.deepEqual(subject.pi.getActiveTools(), admitted, "a supported session_start restores the tool");
	await start(subject, "tui", tui, true);
	assert.deepEqual(subject.pi.getActiveTools(), admitted, "repeated supported session starts remain idempotent");

	await start(subject, "print", {}, false);
	assert.deepEqual(subject.pi.getActiveTools(), siblings, "an unsupported session_start removes the admitted tool");
	await beforeAgentStartWithoutHasUI(subject, tui);
	assert.deepEqual(subject.pi.getActiveTools(), admitted, "a TUI context without hasUI remains supported");
	await beforeAgentStartWithoutHasUI(subject, tui);
	assert.deepEqual(subject.pi.getActiveTools(), admitted, "repeated supported before_agent_start turns remain idempotent");

	await beforeAgentStart(subject, "rpc", { select: async () => undefined }, true);
	assert.deepEqual(subject.pi.getActiveTools(), siblings, "RPC without select+editor support is not interactive for this tool");
	await beforeAgentStart(subject, "rpc", rpc, true);
	assert.deepEqual(subject.pi.getActiveTools(), admitted, "supported RPC restores the admitted tool");
	await beforeAgentStart(subject, "rpc", rpc, true);
	assert.deepEqual(subject.pi.getActiveTools(), admitted, "repeated supported RPC turns remain idempotent");

	assert.deepEqual(subject.activeToolWrites(), [
		siblings,
		admitted,
		siblings,
		admitted,
		siblings,
		admitted,
	], "reconciliation preserves sibling entries and their order");
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"], "session transitions do not re-register the tool");
});

test("does not reconcile active tools before owned owner and incumbent admission", async (t) => {
	const cases: Array<{ name: string; config: QuestionOwnerConfigResolution; inventory: string[]; active: string[] }> = [
		{ name: "owner denied", config: owner("disabled"), inventory: [], active: ["read", "ask_user_question", "other_tool"] },
		{ name: "incumbent present", config: owner("gentle-pi"), inventory: ["ask_user_question"], active: ["read", "ask_user_question", "other_tool"] },
	];
	for (const scenario of cases) {
		await t.test(scenario.name, async () => {
			const subject = host(scenario.inventory, scenario.active);
			createAskUserQuestionExtension(dependencies(scenario.config))(subject.pi as never);
			await start(subject, "tui", { custom: async () => undefined }, true);
			assert.deepEqual(subject.tools, []);
			await start(subject, "print", {}, false);
			for (const handler of subject.beforeAgentStarts) {
				await handler({ type: "before_agent_start" }, { mode: "print", hasUI: false, ui: {} });
			}
			assert.deepEqual(subject.pi.getActiveTools(), scenario.active, "unowned or incumbent entries are untouched");
			assert.deepEqual(subject.activeToolWrites(), [], "denied admission performs no active-set writes");
		});
	}
});

test("leaves an initially unsupported session unregistered until a supported session_start", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "print", {}, false);
	assert.deepEqual([...subject.tools], []);
	assert.deepEqual(subject.pi.getActiveTools(), []);
	assert.deepEqual(subject.activeToolWrites(), []);

	await startWithoutHasUI(subject, "tui");
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"]);
	assert.deepEqual(subject.pi.getActiveTools(), ["ask_user_question"]);
});

test("fails closed when an admitted TUI tool executes with explicit hasUI:false", async () => {
	let driverCalls = 0;
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi"), { present: async () => {
		driverCalls++;
		throw new Error("explicit no-ui execution reached the presentation driver");
	} }))(subject.pi as never);
	await start(subject, "tui");

	const result = await subject.tools[0]!.execute(
		"no-ui-tui",
		{ questions: [legacyQuestion()] },
		new AbortController().signal,
		undefined,
		{ mode: "tui", hasUI: false, ui: { custom: async () => undefined } },
	);
	assert.deepEqual(result, legacyErrorEnvelope("no_ui", "UI not available (running in non-interactive mode)"));
	assert.equal(driverCalls, 0);
	assert.deepEqual(subject.events, []);
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
	const cases: Array<{ name: string; action: ScenarioAction }> = [
		{
			name: "selected",
			action: { kind: "resolve", outcome: { cancelled: false, answers: [{ questionIndex: 0, question: question.question, kind: "option", answer: question.options[0]!.label }] } },
		},
		{ name: "cancelled", action: { kind: "resolve", outcome: { cancelled: true, answers: [] } } },
		{ name: "driver rejection", action: { kind: "reject", error: new Error("scripted-dialog-rejection") } },
	];

	for (const scenario of cases) {
		let entered!: () => void;
		const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
		let release!: (action: (typeof cases)[number]["action"]) => void;
		const driver: QuestionPresentationDriver = { present: (request) => new Promise<RawQuestionnaireOutcome>((resolve, reject) => {
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

test("RPC abort forwards one signal to both selectors, cleans native dialogs, and ignores late answers", async () => {
	const created = createFrozenQuestionnaireRequest("rpc-abort", { questions: [legacyQuestion()] });
	assert.equal(created.ok, true);
	if (!created.ok) throw new Error("valid RPC abort fixture");
	let resolveSelection!: (value: string | undefined) => void;
	let secondSelectionStarted!: () => void;
	const secondSelectionStartedPromise = new Promise<void>((resolve) => { secondSelectionStarted = resolve; });
	const nativeSignals: Array<AbortSignal | undefined> = [];
	let nativeAbortEvents = 0;
	let calls = 0;
	const ui: TestUi = {
		select: async (_title, _options, options) => {
			calls++;
			nativeSignals.push(options?.signal);
			options?.signal?.addEventListener("abort", () => { nativeAbortEvents++; }, { once: true });
			if (calls === 1) return "Choose an option";
			secondSelectionStarted();
			return new Promise<string | undefined>((resolve) => { resolveSelection = resolve; });
		},
		editor: async () => undefined,
	};
	const controller = new AbortController();
	const pending = createRpcQuestionPresentationDriver(ui as never).present(created.request, controller.signal);
	await secondSelectionStartedPromise;
	assert.deepEqual(nativeSignals, [controller.signal, controller.signal], "both native selectors receive the request signal");
	controller.abort();
	assert.equal(nativeAbortEvents, 2, "both native dialogs observe abort for request cleanup");
	assert.deepEqual(await pending, { correlationId: "rpc-abort", answers: [], cancelled: true });
	resolveSelection("Yes");
	await Promise.resolve();
	assert.equal(calls, 2, "a late dialog result cannot start a third selection");
});

test("TUI abort resolves the pending host interaction once and ignores a late completion", async () => {
	const created = createFrozenQuestionnaireRequest("tui-abort", { questions: [legacyQuestion()] });
	assert.equal(created.ok, true);
	if (!created.ok) throw new Error("valid TUI abort fixture");
	let lateDone!: (outcome: unknown) => void;
	let hostCalls = 0;
	const ui = {
		custom(factory: unknown) {
			hostCalls++;
			return new Promise<unknown>((resolve) => {
				lateDone = resolve;
				(factory as (tui: unknown, theme: unknown, keybindings: unknown, done: (outcome: unknown) => void) => unknown)(
					{ terminal: { rows: 24 }, requestRender() {} },
					{ fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text },
					createTestKeybindings(), resolve,
				);
			});
		},
	};
	const controller = new AbortController();
	const pending = createTuiQuestionPresentationDriver(ui as never).present(created.request, controller.signal);
	controller.abort();
	assert.deepEqual(await pending, { correlationId: "tui-abort", answers: [], cancelled: true });
	lateDone({ correlationId: "tui-abort", answers: [{ questionIndex: 0, question: "Proceed?", kind: "option", answer: "Yes" }], cancelled: false });
	await Promise.resolve();
	assert.equal(hostCalls, 1);
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
	for (const session of supportedQuestionnaireSessions) {
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

test("uses built-in model metadata when optional first-party guidance is absent or unreadable in TUI and RPC", async (t) => {
	for (const session of supportedQuestionnaireSessions) {
		for (const scenario of [
			{ name: "absent", readGuidanceConfig: async () => ({}) },
			{ name: "reader throws", readGuidanceConfig: async () => { throw new Error("optional guidance is unreadable"); } },
		]) {
			await t.test(`${session.name} ${scenario.name}`, async () => {
				let reads = 0;
				const subject = host();
				createAskUserQuestionExtension(guidanceDependencies(owner("gentle-pi"), async (agentHome) => {
					reads++;
					assert.equal(agentHome, "/profiles/test");
					return scenario.readGuidanceConfig();
				}))(subject.pi as never);
				await start(subject, session.mode, session.ui, session.hasUI);
				assert.equal(reads, 1);
				assertDefaultModelMetadata(subject.tools[0]!);
			});
		}
	}
});

test("preserves explicitly injected empty guidance fields instead of replacing them with defaults", async (t) => {
	for (const session of supportedQuestionnaireSessions) {
		await t.test(session.name, async () => {
			const subject = host();
			createAskUserQuestionExtension(guidanceDependencies(owner("gentle-pi"), async () => ({
				description: "",
				promptSnippet: "",
				promptGuidelines: [],
			})))(subject.pi as never);
			await start(subject, session.mode, session.ui, session.hasUI);
			const tool = subject.tools[0]!;
			assert.equal(tool.description, "");
			assert.equal(tool.promptSnippet, "");
			assert.deepEqual(tool.promptGuidelines, []);
		});
	}
});

test("applies guidance overrides per field while filling only missing metadata", async (t) => {
	for (const session of supportedQuestionnaireSessions) {
		await t.test(session.name, async () => {
			const partial = host();
			createAskUserQuestionExtension(guidanceDependencies(owner("gentle-pi"), async () => ({
				description: "Configured description",
				promptSnippet: "",
			})))(partial.pi as never);
			await start(partial, session.mode, session.ui, session.hasUI);
			const partialTool = partial.tools[0]!;
			assert.equal(partialTool.description, "Configured description");
			assert.equal(partialTool.promptSnippet, "");
			assert.ok(partialTool.promptGuidelines && partialTool.promptGuidelines.length > 0);
			assert.ok(partialTool.promptGuidelines?.every((guideline) => guideline.includes("ask_user_question")));

			const emptyGuidelines = host();
			createAskUserQuestionExtension(guidanceDependencies(owner("gentle-pi"), async () => ({
				promptGuidelines: [],
			})))(emptyGuidelines.pi as never);
			await start(emptyGuidelines, session.mode, session.ui, session.hasUI);
			const emptyGuidelinesTool = emptyGuidelines.tools[0]!;
			for (const pattern of [/\b(?:requirements|decision|preferences)\b/, /\btrade[- ]?offs?\b/]) {
				assert.match(requiredText(emptyGuidelinesTool.description, "default description"), pattern);
			}
			for (const pattern of [/\bask\b/, /\bbefore\b/, /\bguess/]) {
				assert.match(requiredText(emptyGuidelinesTool.promptSnippet, "default prompt snippet"), pattern);
			}
			assert.deepEqual(emptyGuidelinesTool.promptGuidelines, []);
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

test("the admitted default TUI registration reads collapseKey from its owned first-party config", { concurrency: false }, async () => {
	await withDefaultOwner(async (agentHome) => {
		await writeFile(join(agentHome, "gentle-ai", "ask-user-question.json"), JSON.stringify({
			schema: "gentle-pi.ask-user-question/v1", collapseKey: " CTRL+K ",
		}));
		let component: { cancel(): void; presentationOptions?: { collapseKey?: string } } | undefined;
		let settle!: (outcome: unknown) => void;
		const pending = new Promise<unknown>((resolve) => { settle = resolve; });
		const tui = { terminal: { rows: 24 }, requestRender() {} };
		const ui: TestUi = {
			custom(factory: unknown) {
				component = (factory as (tuiValue: typeof tui, theme: { fg(color: string, text: string): string; bold(text: string): string }, keybindings: object, done: (outcome: unknown) => void) => typeof component)(
					tui,
					{ fg: (_color, text) => text, bold: (text) => text },
					createTestKeybindings(),
					settle,
				);
				return pending;
			},
		};
		const subject = host();
		createAskUserQuestionExtension()(subject.pi as never);
		await start(subject, "tui", ui);
		const execution = subject.tools[0]!.execute("default-collapse-key", { questions: [legacyQuestion()] }, new AbortController().signal, undefined, { mode: "tui", ui });
		try {
			await Promise.resolve();
			await Promise.resolve();
			assert.equal(component?.presentationOptions?.collapseKey, "ctrl+k");
		} finally {
			component?.cancel();
			await execution;
		}
	});
});
