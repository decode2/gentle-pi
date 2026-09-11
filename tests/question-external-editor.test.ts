import assert from "node:assert/strict";
import test from "node:test";
import {
	createQuestionnaireExternalEditor,
	type ExternalEditorDependencies,
} from "../lib/questions/external-editor.ts";

type Scenario = {
	trust?: (() => boolean) | "absent";
	command?: string;
	readValue?: string;
	writeError?: Error;
	exitCode?: number | null;
	executeError?: Error;
	readError?: Error;
	cleanupError?: Error;
};

function fakeDependencies(scenario: Scenario = {}) {
	const trace: string[] = [];
	const temporaryFile = {
		path: "/fake/pi-editor/prompt.md",
		async write(draft: string) {
			trace.push(`write:${draft}`);
			if (scenario.writeError) throw scenario.writeError;
		},
		async read() {
			trace.push("read");
			if (scenario.readError) throw scenario.readError;
			return scenario.readValue ?? "edited";
		},
		async cleanup() {
			trace.push("cleanup");
			if (scenario.cleanupError) throw scenario.cleanupError;
		},
	};
	const dependencies: ExternalEditorDependencies = {
		...(scenario.trust === "absent" ? {} : {
			isProjectTrusted: scenario.trust ?? (() => false),
		}),
		createSettings(projectTrusted) {
			trace.push(`settings:${projectTrusted}`);
			return { getExternalEditorCommand: () => "unused-by-resolver" };
		},
		resolveCommand(settings) {
			trace.push(`resolve:${settings.getExternalEditorCommand()}`);
			return scenario.command ?? "configured-editor --wait";
		},
		async createTemporaryFile() {
			trace.push("create-temp");
			return temporaryFile;
		},
		async execute(command, filePath) {
			trace.push(`execute:${command}:${filePath}`);
			if (scenario.executeError) throw scenario.executeError;
			return { exitCode: scenario.exitCode === undefined ? 0 : scenario.exitCode };
		},
	};
	return { dependencies, trace };
}

function completedTrace(projectTrusted: boolean): string[] {
	return [
		`settings:${projectTrusted}`,
		"resolve:unused-by-resolver",
		"create-temp",
		"write:draft",
		"execute:configured-editor --wait:/fake/pi-editor/prompt.md",
		"read",
		"cleanup",
	];
}

test("identity scaffold constructs a lazy editor without invoking host operations", () => {
	const { dependencies, trace } = fakeDependencies();
	const editor = createQuestionnaireExternalEditor(dependencies);

	assert.equal(typeof editor, "function");
	assert.deepEqual(trace, []);
});

test("delegates a resolver-provided command and removes one final LF after a BOM", async () => {
	const { dependencies, trace } = fakeDependencies({ readValue: "\uFEFFedited\n\n" });
	const edited = await createQuestionnaireExternalEditor(dependencies)("draft");

	assert.deepEqual(trace, completedTrace(false));
	assert.equal(edited, "edited\n");
});

test("forwards explicit trusted context to settings construction", async () => {
	const { dependencies, trace } = fakeDependencies({ trust: () => true });

	await createQuestionnaireExternalEditor(dependencies)("draft");

	assert.deepEqual(trace, completedTrace(true));
});

test("fails closed when project trust is absent", async () => {
	const { dependencies, trace } = fakeDependencies({ trust: "absent" });

	await createQuestionnaireExternalEditor(dependencies)("draft");

	assert.deepEqual(trace, completedTrace(false));
});

test("fails closed when project trust throws", async () => {
	const { dependencies, trace } = fakeDependencies({ trust: () => { throw new Error("trust unavailable"); } });

	await createQuestionnaireExternalEditor(dependencies)("draft");

	assert.deepEqual(trace, completedTrace(false));
});

test("preserves a write error when cleanup also fails", async () => {
	const writeError = new Error("write failed");
	const { dependencies, trace } = fakeDependencies({ writeError, cleanupError: new Error("cleanup failed") });

	await assert.rejects(createQuestionnaireExternalEditor(dependencies)("draft"), writeError);
	assert.deepEqual(trace, ["settings:false", "resolve:unused-by-resolver", "create-temp", "write:draft", "cleanup"]);
});

test("preserves an execution error when cleanup also fails", async () => {
	const executeError = new Error("spawn failed");
	const { dependencies, trace } = fakeDependencies({ executeError, cleanupError: new Error("cleanup failed") });

	await assert.rejects(createQuestionnaireExternalEditor(dependencies)("draft"), executeError);
	assert.deepEqual(trace, [
		"settings:false",
		"resolve:unused-by-resolver",
		"create-temp",
		"write:draft",
		"execute:configured-editor --wait:/fake/pi-editor/prompt.md",
		"cleanup",
	]);
});

test("rejects a nonzero editor exit after cleanup without reading", async () => {
	const { dependencies, trace } = fakeDependencies({ exitCode: 23 });

	await assert.rejects(createQuestionnaireExternalEditor(dependencies)("draft"));
	assert.deepEqual(trace, [
		"settings:false",
		"resolve:unused-by-resolver",
		"create-temp",
		"write:draft",
		"execute:configured-editor --wait:/fake/pi-editor/prompt.md",
		"cleanup",
	]);
});

test("rejects a signal-ended editor exit after cleanup without reading", async () => {
	const { dependencies, trace } = fakeDependencies({ exitCode: null });

	await assert.rejects(createQuestionnaireExternalEditor(dependencies)("draft"));
	assert.deepEqual(trace, [
		"settings:false",
		"resolve:unused-by-resolver",
		"create-temp",
		"write:draft",
		"execute:configured-editor --wait:/fake/pi-editor/prompt.md",
		"cleanup",
	]);
});

test("preserves a read error after cleanup", async () => {
	const readError = new Error("read failed");
	const { dependencies, trace } = fakeDependencies({ readError });

	await assert.rejects(createQuestionnaireExternalEditor(dependencies)("draft"), readError);
	assert.deepEqual(trace, completedTrace(false));
});

test("reports cleanup failure after successful editor operations", async () => {
	const cleanupError = new Error("cleanup failed");
	const { dependencies, trace } = fakeDependencies({ cleanupError });

	await assert.rejects(createQuestionnaireExternalEditor(dependencies)("draft"), cleanupError);
	assert.deepEqual(trace, completedTrace(false));
});
