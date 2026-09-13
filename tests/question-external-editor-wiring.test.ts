import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";

const hostCalls: Array<{ operation: string; value: unknown }> = [];
let hostFactoryCalls = 0;
let edited = "edited once";

const fakeNodeHost = {
	createSettings(cwd: string, agentHome: string, options: { projectTrusted: boolean }) {
		hostCalls.push({ operation: "settings", value: { cwd, agentHome, options } });
		return { getExternalEditorCommand: () => "fake-editor --wait" };
	},
	async createTemporaryDirectory(options: { prefix: string; mode: number }) { hostCalls.push({ operation: "directory", value: options }); return "/controlled/tmp"; },
	async createTemporaryFile(directory: string, options: { name: string; mode: number }) { hostCalls.push({ operation: "file", value: { directory, options } }); return "/controlled/tmp/prompt.md"; },
	async writeFile(path: string, contents: string) { hostCalls.push({ operation: "write", value: { path, contents } }); },
	async readFile(path: string) { hostCalls.push({ operation: "read", value: path }); return edited; },
	async removeTemporaryDirectory(path: string) { hostCalls.push({ operation: "cleanup", value: path }); },
	async execute(command: string, path: string, options: { cwd: string; stdio: "inherit" }) {
		hostCalls.push({ operation: "execute", value: { command, path, options } });
		return { exitCode: 0 };
	},
};

const fakeFactory = async () => {
	hostFactoryCalls++;
	return fakeNodeHost;
};

mock.module("../lib/questions/external-editor-node-host.ts", { namedExports: { createQuestionnaireExternalEditorNodeHost: fakeFactory } });
const mockedNodeHost = await import("../lib/questions/external-editor-node-host.ts");
const { createAskUserQuestionExtension } = await import("../extensions/ask-user-question.ts");

type SessionContext = { mode: string; hasUI?: boolean; cwd?: string; isProjectTrusted?: () => boolean; ui: Record<string, unknown> };
type RegisteredTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type CapturedComponent = { cancel(): void; presentationOptions?: { externalEditor?: (draft: string) => Promise<string> } };

function resetFakeHost() {
	hostCalls.length = 0;
	hostFactoryCalls = 0;
	edited = "edited once";
}

function extensionHost(inventory: string[] = []) {
	const sessions: Array<(event: unknown, context: SessionContext) => Promise<void>> = [];
	const tools: RegisteredTool[] = [];
	return {
		sessions,
		tools,
		pi: {
			on(event: string, handler: (event: unknown, context: SessionContext) => Promise<void>) { if (event === "session_start") sessions.push(handler); },
			registerTool(tool: RegisteredTool) { tools.push(tool); },
			getAllTools() { return inventory.map((name) => ({ name })); },
			events: { emit() {} },
		},
	};
}

async function withFixture(run: (agentHome: string) => Promise<void>) {
	const fixture = await mkdtemp(join(tmpdir(), "gentle-pi-questionnaire-editor-"));
	const original = new Map(["HOME", "XDG_CONFIG_HOME", "GENTLE_PI_AGENT_HOME", "PI_CODING_AGENT_DIR"].map((key) => [key, process.env[key]]));
	const agentHome = join(fixture, "agent");
	try {
		process.env.HOME = join(fixture, "home");
		process.env.XDG_CONFIG_HOME = join(fixture, "xdg");
		process.env.GENTLE_PI_AGENT_HOME = agentHome;
		process.env.PI_CODING_AGENT_DIR = agentHome;
		await run(agentHome);
	} finally {
		for (const [key, value] of original) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		await rm(fixture, { recursive: true, force: true });
	}
}

async function admitDefaultOwner(agentHome: string, owner = "gentle-pi") {
	await mkdir(join(agentHome, "gentle-ai"), { recursive: true });
	await writeFile(join(agentHome, "gentle-ai", "question-owner.json"), JSON.stringify({ schema: "gentle-pi.question-owner/v1", owner }));
}

const validInput = { questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }] }] };
const signal = new AbortController().signal;

async function start(subject: ReturnType<typeof extensionHost>, context: SessionContext) {
	assert.equal(subject.sessions.length, 1);
	await subject.sessions[0]!({ type: "session_start" }, context);
}

test("the node-host module mock is installed before loading the extension", { concurrency: false }, () => {
	assert.equal(mockedNodeHost.createQuestionnaireExternalEditorNodeHost, fakeFactory);
	assert.equal(hostFactoryCalls, 0);
});

test("the admitted default TUI callback is lazy and runs the real runtime bridge with the execution context", { concurrency: false }, async () => {
	await withFixture(async (agentHome) => {
		resetFakeHost();
		await admitDefaultOwner(agentHome);
		const subject = extensionHost();
		createAskUserQuestionExtension()(subject.pi as never);
		await start(subject, { mode: "tui", cwd: "/registration-cwd", isProjectTrusted: () => true, ui: { custom: async () => undefined } });
		assert.equal(hostFactoryCalls, 0, "registration must not load the node host");
		assert.equal(subject.tools.length, 1);

		const invalid = await subject.tools[0]!.execute("invalid", { questions: [] }, signal, undefined, { mode: "tui", cwd: "/execution-cwd", isProjectTrusted: () => false, ui: {} });
		assert.deepEqual(invalid, { content: [{ type: "text", text: "Error: At least one question is required" }], details: { answers: [], cancelled: true, error: "no_questions" } });
		assert.equal(hostFactoryCalls, 0, "validation must not load the node host");

		let component: CapturedComponent | undefined;
		let settle!: (outcome: unknown) => void;
		const pending = new Promise<unknown>((resolve) => { settle = resolve; });
		let trusted = false;
		const tui = { terminal: { rows: 24 }, stop() {}, start() {}, requestRender() {} };
		const ui = { custom(factory: unknown) {
			component = (factory as (tuiValue: typeof tui, theme: { fg(color: string, text: string): string; bold(text: string): string }, keybindings: object, done: (outcome: unknown) => void) => CapturedComponent)(tui, { fg: (_color, text) => text, bold: (text) => text }, {}, settle);
			return pending;
		} };
		const execution = subject.tools[0]!.execute("external-editor", validInput, signal, undefined, { mode: "tui", cwd: "/execution-cwd", isProjectTrusted: () => trusted, ui });
		try {
			await Promise.resolve();
			await Promise.resolve();
			const externalEditor = component?.presentationOptions?.externalEditor;
			assert.equal(typeof externalEditor, "function", "the admitted default TUI view offers Ctrl+G editing");
			assert.equal(hostFactoryCalls, 0, "opening the questionnaire must not load the node host");
			assert.equal(await externalEditor!("original draft"), "edited once");
			trusted = true;
			edited = "edited twice";
			assert.equal(await externalEditor!("second draft"), "edited twice");
			assert.equal(hostFactoryCalls, 2, "each actual edit lazily creates its host");
			assert.deepEqual(hostCalls, [
				{ operation: "settings", value: { cwd: "/execution-cwd", agentHome, options: { projectTrusted: false } } },
				{ operation: "directory", value: { prefix: "pi-editor-", mode: 0o700 } }, { operation: "file", value: { directory: "/controlled/tmp", options: { name: "prompt.md", mode: 0o600 } } },
				{ operation: "write", value: { path: "/controlled/tmp/prompt.md", contents: "original draft" } }, { operation: "execute", value: { command: "fake-editor --wait", path: "/controlled/tmp/prompt.md", options: { cwd: "/execution-cwd", stdio: "inherit" } } },
				{ operation: "read", value: "/controlled/tmp/prompt.md" }, { operation: "cleanup", value: "/controlled/tmp" },
				{ operation: "settings", value: { cwd: "/execution-cwd", agentHome, options: { projectTrusted: true } } },
				{ operation: "directory", value: { prefix: "pi-editor-", mode: 0o700 } }, { operation: "file", value: { directory: "/controlled/tmp", options: { name: "prompt.md", mode: 0o600 } } },
				{ operation: "write", value: { path: "/controlled/tmp/prompt.md", contents: "second draft" } }, { operation: "execute", value: { command: "fake-editor --wait", path: "/controlled/tmp/prompt.md", options: { cwd: "/execution-cwd", stdio: "inherit" } } },
				{ operation: "read", value: "/controlled/tmp/prompt.md" }, { operation: "cleanup", value: "/controlled/tmp" },
			]);
		} finally {
			component?.cancel();
			await execution;
		}
	});
});

test("RPC, no-UI, denied ownership, and incumbency never load the node host", { concurrency: false }, async () => {
	await withFixture(async (agentHome) => {
		resetFakeHost();
		await admitDefaultOwner(agentHome);
		const rpc = extensionHost();
		createAskUserQuestionExtension()(rpc.pi as never);
		await start(rpc, { mode: "rpc", hasUI: true, cwd: "/rpc", isProjectTrusted: () => true, ui: { select: async () => "Cancel", editor: async () => undefined } });
		await rpc.tools[0]!.execute("rpc", validInput, signal, undefined, { mode: "rpc", hasUI: true, cwd: "/rpc", isProjectTrusted: () => true, ui: { select: async () => "Cancel", editor: async () => undefined } });
		const noUi = await rpc.tools[0]!.execute("no-ui", validInput, signal, undefined, { mode: "rpc", hasUI: true, cwd: "/rpc", isProjectTrusted: () => true, ui: {} });
		assert.deepEqual(noUi, { content: [{ type: "text", text: "Error: UI not available (running in non-interactive mode)" }], details: { answers: [], cancelled: true, error: "no_ui" } });

		await admitDefaultOwner(agentHome, "disabled");
		const denied = extensionHost();
		createAskUserQuestionExtension()(denied.pi as never);
		await start(denied, { mode: "tui", cwd: "/denied", isProjectTrusted: () => true, ui: { custom: async () => undefined } });
		assert.deepEqual(denied.tools, []);

		await admitDefaultOwner(agentHome);
		const incumbent = extensionHost(["ask_user_question"]);
		createAskUserQuestionExtension()(incumbent.pi as never);
		await start(incumbent, { mode: "tui", cwd: "/incumbent", isProjectTrusted: () => true, ui: { custom: async () => undefined } });
		assert.deepEqual(incumbent.tools, []);
		assert.equal(hostFactoryCalls, 0, "non-editor paths never load the node host");
	});
});
