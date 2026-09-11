import assert from "node:assert/strict";
import test from "node:test";
import {
	createQuestionnaireExternalEditorRuntime,
	type QuestionnaireExternalEditorRuntimeContext,
	type QuestionnaireExternalEditorRuntimeHost,
} from "../lib/questions/external-editor-runtime.ts";

type Scenario = {
	command?: string;
	readValue?: string;
	temporaryDirectoryError?: Error;
	temporaryFileError?: Error;
	writeError?: Error;
	executeError?: Error;
	exitCode?: number | null;
	readError?: Error;
	cleanupError?: Error;
};

function fakeHost(scenario: Scenario = {}) {
	const trace: string[] = [];
	const host: QuestionnaireExternalEditorRuntimeHost = {
		createSettings(cwd, agentHome, options) {
			trace.push(`settings:${cwd}:${agentHome}:${options.projectTrusted}`);
			return { getExternalEditorCommand() {
				trace.push("command");
				return scenario.command ?? "configured editor --wait --line 7";
			} };
		},
		async createTemporaryDirectory(options) {
			trace.push(`temp-dir:${options.prefix}:${options.mode.toString(8)}`);
			if (scenario.temporaryDirectoryError) throw scenario.temporaryDirectoryError;
			return "/isolated/tmp/pi-editor-123";
		},
		async createTemporaryFile(directory, options) {
			trace.push(`temp-file:${directory}:${options.name}:${options.mode.toString(8)}`);
			if (scenario.temporaryFileError) throw scenario.temporaryFileError;
			return "/isolated/tmp/pi-editor-123/prompt.md";
		},
		async writeFile(path, contents) {
			trace.push(`write:${path}:${contents}`);
			if (scenario.writeError) throw scenario.writeError;
		},
		async readFile(path) {
			trace.push(`read:${path}`);
			if (scenario.readError) throw scenario.readError;
			return scenario.readValue ?? "edited";
		},
		async removeTemporaryDirectory(path) {
			trace.push(`cleanup:${path}`);
			if (scenario.cleanupError) throw scenario.cleanupError;
		},
		async execute(command, filePath, options) {
			trace.push(`execute:${command}:${filePath}:${options.cwd}:${options.stdio}`);
			if (scenario.executeError) throw scenario.executeError;
			return { exitCode: scenario.exitCode === undefined ? 0 : scenario.exitCode };
		},
	};
	return { host, trace };
}

function context(trust?: () => boolean): QuestionnaireExternalEditorRuntimeContext {
	return {
		cwd: "/workspace/current-session",
		agentHome: "/workspace/agent-home",
		...(trust === undefined ? {} : { isProjectTrusted: trust }),
	};
}

function completedTrace(projectTrusted: boolean, draft = "draft"): string[] {
	return [
		`settings:/workspace/current-session:/workspace/agent-home:${projectTrusted}`,
		"command",
		"temp-dir:pi-editor-:700",
		"temp-file:/isolated/tmp/pi-editor-123:prompt.md:600",
		`write:/isolated/tmp/pi-editor-123/prompt.md:${draft}`,
		"execute:configured editor --wait --line 7:/isolated/tmp/pi-editor-123/prompt.md:/workspace/current-session:inherit",
		"read:/isolated/tmp/pi-editor-123/prompt.md",
		"cleanup:/isolated/tmp/pi-editor-123",
	];
}

test("identity construction is lazy and does not invoke a host operation", () => {
	const { host, trace } = fakeHost();
	const editor = createQuestionnaireExternalEditorRuntime(context(() => true), host);

	assert.equal(typeof editor, "function");
	assert.deepEqual(trace, []);
});

test("builds the adapter with current context, opaque command, restrictive temporary resources, and inherited terminal execution", async () => {
	const { host, trace } = fakeHost();

	await createQuestionnaireExternalEditorRuntime(context(() => true), host)("draft");

	assert.deepEqual(trace, completedTrace(true));
});

test("fails closed for false, absent, and throwing project trust", async (t) => {
	for (const scenario of [
		{ name: "false", trust: () => false },
		{ name: "absent", trust: undefined },
		{ name: "throws", trust: () => { throw new Error("trust unavailable"); } },
	]) {
		await t.test(scenario.name, async () => {
			const { host, trace } = fakeHost();
			await createQuestionnaireExternalEditorRuntime(context(scenario.trust), host)("draft");
			assert.deepEqual(trace, completedTrace(false));
		});
	}
});

test("reads trust for each edit instead of retaining a registration-time result", async () => {
	let trusted = true;
	const { host, trace } = fakeHost();
	const editor = createQuestionnaireExternalEditorRuntime(context(() => trusted), host);

	await editor("first");
	trusted = false;
	await editor("second");

	assert.deepEqual(trace, [
		...completedTrace(true, "first"),
		...completedTrace(false, "second"),
	]);
});

test("normalizes editor bytes through the pure adapter after the runtime host reads them", async () => {
	const { host, trace } = fakeHost({ readValue: "\uFEFFedited\n\n" });

	const edited = await createQuestionnaireExternalEditorRuntime(context(() => true), host)("draft");

	assert.equal(edited, "edited\n");
	assert.deepEqual(trace, completedTrace(true));
});

test("removes a created directory when secure file initialization fails without executing or reading", async () => {
	const failure = new Error("file initialization failed");
	const { host, trace } = fakeHost({ temporaryFileError: failure });

	await assert.rejects(createQuestionnaireExternalEditorRuntime(context(), host)("draft"), failure);
	assert.deepEqual(trace, [
		"settings:/workspace/current-session:/workspace/agent-home:false",
		"command",
		"temp-dir:pi-editor-:700",
		"temp-file:/isolated/tmp/pi-editor-123:prompt.md:600",
		"cleanup:/isolated/tmp/pi-editor-123",
	]);
});

for (const scenario of [
	{ name: "temporary directory creation", value: { temporaryDirectoryError: new Error("directory failed") }, trace: ["settings:/workspace/current-session:/workspace/agent-home:false", "command", "temp-dir:pi-editor-:700"] },
	{ name: "draft write", value: { writeError: new Error("write failed") }, trace: ["settings:/workspace/current-session:/workspace/agent-home:false", "command", "temp-dir:pi-editor-:700", "temp-file:/isolated/tmp/pi-editor-123:prompt.md:600", "write:/isolated/tmp/pi-editor-123/prompt.md:draft", "cleanup:/isolated/tmp/pi-editor-123"] },
	{ name: "editor launch", value: { executeError: new Error("spawn failed") }, trace: ["settings:/workspace/current-session:/workspace/agent-home:false", "command", "temp-dir:pi-editor-:700", "temp-file:/isolated/tmp/pi-editor-123:prompt.md:600", "write:/isolated/tmp/pi-editor-123/prompt.md:draft", "execute:configured editor --wait --line 7:/isolated/tmp/pi-editor-123/prompt.md:/workspace/current-session:inherit", "cleanup:/isolated/tmp/pi-editor-123"] },
	{ name: "nonzero editor exit", value: { exitCode: 12 }, trace: ["settings:/workspace/current-session:/workspace/agent-home:false", "command", "temp-dir:pi-editor-:700", "temp-file:/isolated/tmp/pi-editor-123:prompt.md:600", "write:/isolated/tmp/pi-editor-123/prompt.md:draft", "execute:configured editor --wait --line 7:/isolated/tmp/pi-editor-123/prompt.md:/workspace/current-session:inherit", "cleanup:/isolated/tmp/pi-editor-123"] },
	{ name: "signal-ended editor exit", value: { exitCode: null }, trace: ["settings:/workspace/current-session:/workspace/agent-home:false", "command", "temp-dir:pi-editor-:700", "temp-file:/isolated/tmp/pi-editor-123:prompt.md:600", "write:/isolated/tmp/pi-editor-123/prompt.md:draft", "execute:configured editor --wait --line 7:/isolated/tmp/pi-editor-123/prompt.md:/workspace/current-session:inherit", "cleanup:/isolated/tmp/pi-editor-123"] },
	{ name: "edited file read", value: { readError: new Error("read failed") }, trace: ["settings:/workspace/current-session:/workspace/agent-home:false", "command", "temp-dir:pi-editor-:700", "temp-file:/isolated/tmp/pi-editor-123:prompt.md:600", "write:/isolated/tmp/pi-editor-123/prompt.md:draft", "execute:configured editor --wait --line 7:/isolated/tmp/pi-editor-123/prompt.md:/workspace/current-session:inherit", "read:/isolated/tmp/pi-editor-123/prompt.md", "cleanup:/isolated/tmp/pi-editor-123"] },
	{ name: "cleanup after success", value: { cleanupError: new Error("cleanup failed") }, trace: ["settings:/workspace/current-session:/workspace/agent-home:false", "command", "temp-dir:pi-editor-:700", "temp-file:/isolated/tmp/pi-editor-123:prompt.md:600", "write:/isolated/tmp/pi-editor-123/prompt.md:draft", "execute:configured editor --wait --line 7:/isolated/tmp/pi-editor-123/prompt.md:/workspace/current-session:inherit", "read:/isolated/tmp/pi-editor-123/prompt.md", "cleanup:/isolated/tmp/pi-editor-123"] },
] as const) {
	test(`propagates ${scenario.name} failure with its resource sequence`, async () => {
		const { host, trace } = fakeHost(scenario.value);

		await assert.rejects(createQuestionnaireExternalEditorRuntime(context(), host)("draft"));
		assert.deepEqual(trace, scenario.trace);
	});
}
