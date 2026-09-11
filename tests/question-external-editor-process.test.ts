import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, mock, test } from "node:test";
import { join } from "node:path";

type Host = {
	createSettings(cwd: string, agentHome: string, options: { projectTrusted: boolean }): unknown;
	createTemporaryDirectory(options: { prefix: string; mode: number }): Promise<string>;
	createTemporaryFile(directory: string, options: { name: string; mode: number }): Promise<string>;
	writeFile(path: string, contents: string): Promise<void>;
	readFile(path: string): Promise<string>;
	removeTemporaryDirectory(path: string): Promise<void>;
	execute(command: string, filePath: string, options: { cwd: string; stdio: "inherit" }): Promise<{ exitCode: number | null }>;
};

const calls = {
	settings: [] as unknown[][],
	mkdtemp: [] as unknown[][],
	chmod: [] as unknown[][],
	open: [] as unknown[][],
	close: [] as unknown[][],
	writeFile: [] as unknown[][],
	readFile: [] as unknown[][],
	rm: [] as unknown[][],
	spawn: [] as unknown[][],
};
type FaultOperation = "mkdtemp" | "chmod" | "open" | "close" | "writeFile" | "readFile";

let faults: Partial<Record<FaultOperation, Error>> = {};
let fileContents = "edited";
let child = new EventEmitter();

function reset() {
	for (const entries of Object.values(calls)) entries.length = 0;
	faults = {};
	fileContents = "edited";
	child = new EventEmitter();
}

mock.module("@earendil-works/pi-coding-agent", {
	namedExports: {
		SettingsManager: {
			create(...args: unknown[]) {
				calls.settings.push(args);
				return { getExternalEditorCommand: () => "configured editor" };
			},
		},
	},
});
mock.module("node:os", { namedExports: { tmpdir: () => "/fake/system-tmp" } });
mock.module("node:fs/promises", {
	namedExports: {
		async mkdtemp(...args: unknown[]) { calls.mkdtemp.push(args); if (faults.mkdtemp) throw faults.mkdtemp; return "/fake/system-tmp/pi-editor-123"; },
		async chmod(...args: unknown[]) { calls.chmod.push(args); if (faults.chmod) throw faults.chmod; },
		async open(...args: unknown[]) {
			calls.open.push(args);
			if (faults.open) throw faults.open;
			return { async close() { calls.close.push([]); if (faults.close) throw faults.close; } };
		},
		async writeFile(...args: unknown[]) { calls.writeFile.push(args); if (faults.writeFile) throw faults.writeFile; },
		async readFile(...args: unknown[]) { calls.readFile.push(args); if (faults.readFile) throw faults.readFile; return fileContents; },
		async rm(...args: unknown[]) { calls.rm.push(args); },
	},
});
mock.module("node:child_process", {
	namedExports: {
		spawn(...args: unknown[]) { calls.spawn.push(args); return child; },
	},
});

after(() => mock.restoreAll());

const { createQuestionnaireExternalEditorNodeHost } = await import("../lib/questions/external-editor-node-host.ts") as {
	createQuestionnaireExternalEditorNodeHost(): Promise<Host>;
};

async function host(): Promise<Host> {
	return await createQuestionnaireExternalEditorNodeHost();
}

function capturePending(pending: Promise<{ exitCode: number | null }>) {
	void pending.catch(() => {});
	return pending;
}

async function requireSpawnListener(event: "close" | "error") {
	for (let attempt = 0; attempt < 2 && calls.spawn.length === 0; attempt += 1) await Promise.resolve();
	assert.equal(calls.spawn.length, 1, "the production host must call the mocked spawn before this fixture emits an event");
	assert.equal(child.listenerCount(event), 1, `the production host must listen for child ${event}`);
}

async function withPlatform(platform: string, run: () => Promise<void>) {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	assert.ok(descriptor);
	Object.defineProperty(process, "platform", { ...descriptor, value: platform });
	try {
		await run();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

test("constructs a complete host without performing a filesystem or process operation", async () => {
	reset();
	const value = await host();

	assert.deepEqual(Object.keys(value).sort(), ["createSettings", "createTemporaryDirectory", "createTemporaryFile", "execute", "readFile", "removeTemporaryDirectory", "writeFile"]);
	assert.deepEqual(calls, { settings: [], mkdtemp: [], chmod: [], open: [], close: [], writeFile: [], readFile: [], rm: [], spawn: [] });
});

test("delegates settings construction with the current runtime context and trust option", async () => {
	reset();
	const value = await host();
	const settings = value.createSettings("/workspace/session", "/workspace/agent", { projectTrusted: true });

	assert.equal((settings as { getExternalEditorCommand(): string }).getExternalEditorCommand(), "configured editor");
	assert.deepEqual(calls.settings, [["/workspace/session", "/workspace/agent", { projectTrusted: true }]]);
});

test("creates restrictive temporary resources and delegates UTF-8 file operations", async () => {
	reset();
	const value = await host();
	const directory = await value.createTemporaryDirectory({ prefix: "pi-editor-", mode: 0o700 });
	const path = await value.createTemporaryFile(directory, { name: "prompt.md", mode: 0o600 });
	await value.writeFile(path, "draft");
	fileContents = "edited";
	assert.equal(await value.readFile(path), "edited");
	await value.removeTemporaryDirectory(directory);

	assert.deepEqual(calls.mkdtemp, [[join("/fake/system-tmp", "pi-editor-")]]);
	assert.deepEqual(calls.chmod, [[directory, 0o700]]);
	assert.deepEqual(calls.open, [[join(directory, "prompt.md"), "wx", 0o600]]);
	assert.deepEqual(calls.close, [[]]);
	assert.deepEqual(calls.writeFile, [[path, "draft", "utf8"]]);
	assert.deepEqual(calls.readFile, [[path, "utf8"]]);
	assert.deepEqual(calls.rm, [[directory, { recursive: true, force: true }]]);
});

test("removes a created directory when restrictive chmod fails while preserving the chmod error", async () => {
	reset();
	const value = await host();
	const chmodFailure = new Error("chmod failed");
	faults.chmod = chmodFailure;
	let caught: unknown;
	try {
		await value.createTemporaryDirectory({ prefix: "pi-editor-", mode: 0o700 });
	} catch (error) {
		caught = error;
	}

	assert.equal(caught, chmodFailure);
	assert.deepEqual(calls.mkdtemp, [[join("/fake/system-tmp", "pi-editor-")]]);
	assert.deepEqual(calls.chmod, [["/fake/system-tmp/pi-editor-123", 0o700]]);
	assert.deepEqual(calls.rm, [["/fake/system-tmp/pi-editor-123", { recursive: true, force: true }]]);
});

test("splits Pi editor commands literally on POSIX and appends the temporary file without a shell", async () => {
	await withPlatform("linux", async () => {
		reset();
		const pending = capturePending((await host()).execute('code --wait "quote;meta"', "/fake/prompt.md", { cwd: "/workspace", stdio: "inherit" }));
		await requireSpawnListener("close");
		queueMicrotask(() => child.emit("close", 0));
		assert.deepEqual(await pending, { exitCode: 0 });
		assert.deepEqual(calls.spawn, [["code", ["--wait", '"quote;meta"', "/fake/prompt.md"], { cwd: "/workspace", stdio: "inherit", shell: false }]]);
	});
});

test("uses Pi's Windows shell setting without changing its literal argument contract", async () => {
	await withPlatform("win32", async () => {
		reset();
		const pending = capturePending((await host()).execute("editor --line 7", "C:\\temp\\prompt.md", { cwd: "C:\\work", stdio: "inherit" }));
		await requireSpawnListener("close");
		queueMicrotask(() => child.emit("close", 12));
		assert.deepEqual(await pending, { exitCode: 12 });
		assert.deepEqual(calls.spawn, [["editor", ["--line", "7", "C:\\temp\\prompt.md"], { cwd: "C:\\work", stdio: "inherit", shell: true }]]);
	});
});

test("settles a launch error once even when close follows it", async () => {
	reset();
	const pending = capturePending((await host()).execute("editor", "/fake/prompt.md", { cwd: "/workspace", stdio: "inherit" }));
	await requireSpawnListener("error");
	await requireSpawnListener("close");
	queueMicrotask(() => { child.emit("error", new Error("launch failed")); child.emit("close", 3); });

	assert.deepEqual(await pending, { exitCode: null });
});
