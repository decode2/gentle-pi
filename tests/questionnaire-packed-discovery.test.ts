import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
	type AgentSession,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import {
	extractArtifact, frozenModules, gitBlob, loadArtifact, verifyExtraction, verifyIntegrity,
} from "./fixtures/questionnaire-packed-artifact.ts";

const question = "extensions/ask-user-question.ts";
const view = "lib/questionnaire/questionnaire-view.ts";
const toolName = "ask_user_question";
const sourceRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

// Resolve the public ESM export, not an unsupported CJS SDK export.
function assertSDKVersion(): void {
	const entry = new URL(import.meta.resolve("@earendil-works/pi-coding-agent"));
	assert.ok(entry.pathname.endsWith("/dist/index.js"), "expected unbundled SDK entry");
	const metadata = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
	assert.equal(metadata.name, "@earendil-works/pi-coding-agent");
	assert.equal(metadata.version, "0.87.1");
}

// SDK-owned theme metadata is allowed. No dialog, editor, rendering or dispatch.
function unexpectedUI(): never {
	throw new Error("BLOCKED FIXTURE: discovery attempted UI interaction");
}
const uiContext: Omit<ExtensionUIContext, "theme"> = {
	select: unexpectedUI,
	confirm: unexpectedUI,
	input: unexpectedUI,
	notify: unexpectedUI,
	onTerminalInput: unexpectedUI,
	setStatus: unexpectedUI,
	setWorkingMessage: unexpectedUI,
	setWorkingVisible: unexpectedUI,
	setWorkingIndicator: unexpectedUI,
	setHiddenThinkingLabel: unexpectedUI,
	setWidget: unexpectedUI,
	setFooter: unexpectedUI,
	setHeader: unexpectedUI,
	setTitle: unexpectedUI,
	custom: unexpectedUI,
	pasteToEditor: unexpectedUI,
	setEditorText: unexpectedUI,
	getEditorText: unexpectedUI,
	editor: unexpectedUI,
	addAutocompleteProvider: unexpectedUI,
	setEditorComponent: unexpectedUI,
	getEditorComponent: unexpectedUI,
	getAllThemes: unexpectedUI,
	getTheme: unexpectedUI,
	setTheme: unexpectedUI,
	getToolsExpanded: unexpectedUI,
	setToolsExpanded: unexpectedUI,
};

type Control = "selected" | "excluded" | "missing-view";

function assertFrozenSource(): void {
	for (const relative of [question, view] as const) {
		const path = join(sourceRoot, relative);
		assert.ok(existsSync(path), `source control missing: ${relative}`);
		assert.equal(gitBlob(readFileSync(path)), frozenModules[relative]);
	}
}

function assertAbsent(session: AgentSession): void {
	assert.equal(session.getAllTools().some((tool) => tool.name === toolName), false);
	assert.equal(session.getActiveToolNames().includes(toolName), false);
	assert.equal(session.getToolDefinition(toolName), undefined);
}

async function withSession(
	control: Control,
	observe: (session: AgentSession, bind: () => Promise<void>) => Promise<void>,
): Promise<void> {
	assertSDKVersion();
	const artifactDirectory = process.env.PACK_ARTIFACT_DIR;
	assert.ok(artifactDirectory && isAbsolute(artifactDirectory), "absolute hosted PACK_ARTIFACT_DIR required");
	const artifact = loadArtifact(artifactDirectory);
	const archiveBytes = readFileSync(artifact.archivePath);
	const temporary = mkdtempSync(join(tmpdir(), "questionnaire-packed-sdk-"));
	const packedRoot = join(temporary, "package");
	const selectedHome = join(temporary, "selected-agent");
	const sdkHome = join(temporary, "sdk-agent");
	const cwd = join(temporary, "workspace");
	const home = join(temporary, "home");
	const savedEnvironment = { ...process.env };
	let session: AgentSession | undefined;
	try {
		// Each scenario gets a unique package path/cwd: no positive module-cache reuse.
		extractArtifact(artifact, packedRoot);
		verifyExtraction(packedRoot, artifact.report);
		assertFrozenSource();
		const packedQuestion = join(packedRoot, question);
		assert.ok(realpathSync(packedQuestion).startsWith(realpathSync(packedRoot) + sep));
		assert.equal(existsSync(join(packedRoot, "node_modules")), false);
		if (control === "missing-view") {
			// Verify pristine FIRST; the subsequent failure must come from the SDK loader.
			unlinkSync(join(packedRoot, view));
			assert.equal(existsSync(join(packedRoot, view)), false);
		}
		for (const directory of [selectedHome, sdkHome, cwd, home]) mkdirSync(directory);
		// Exclude operator credentials, provider variables, homes and resource overrides.
		process.env = {
			PATH: savedEnvironment.PATH,
			HOME: home,
			TMPDIR: temporary,
			XDG_CONFIG_HOME: home,
			XDG_CACHE_HOME: home,
			XDG_DATA_HOME: home,
			GENTLE_PI_AGENT_HOME: selectedHome,
			PI_CODING_AGENT_DIR: sdkHome,
		};
		assert.notEqual(selectedHome, sdkHome);
		mkdirSync(join(selectedHome, "gentle-ai"));
		writeFileSync(join(selectedHome, "gentle-ai", "question-owner.json"), JSON.stringify({
			version: 1, owner: "gentle-pi", enabled: true,
		}));
		const settingsManager = SettingsManager.inMemory({
			packages: [{
				source: packedRoot,
				extensions: control === "excluded" ? [] : [question],
				skills: [], prompts: [], themes: [],
			}],
		}, { projectTrusted: false });
		const modelRuntime = await ModelRuntime.create({
			authPath: join(sdkHome, "auth.json"),
			modelsPath: join(sdkHome, "models.json"),
			modelsStorePath: join(sdkHome, "models-store.json"),
			refreshOnCreate: false,
			allowModelNetwork: false,
		});
		const services = await createAgentSessionServices({
			cwd, agentDir: sdkHome, settingsManager, modelRuntime,
			resourceLoaderOptions: {
				noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			},
		});
		const loaded = services.resourceLoader.getExtensions();
		assert.deepEqual(services.diagnostics, [], "service setup must succeed in every control");
		assert.deepEqual(services.resourceLoader.getSkills().skills, []);
		assert.deepEqual(services.resourceLoader.getPrompts().prompts, []);
		assert.deepEqual(services.resourceLoader.getThemes().themes, []);
		assert.deepEqual(services.resourceLoader.getAgentsFiles().agentsFiles, []);
		assert.equal(settingsManager.isProjectTrusted(), false);
		assert.deepEqual(modelRuntime.getAvailableSnapshot(), []);
		if (control === "missing-view") {
			assert.deepEqual(loaded.extensions, []);
			assert.equal(loaded.errors.length, 1, "only the targeted packed import may fail");
			assert.equal(loaded.errors[0].path, packedQuestion);
			assert.match(loaded.errors[0].error, /^Failed to load extension:/);
			assert.match(loaded.errors[0].error, /Cannot find module/);
			assert.match(loaded.errors[0].error, /questionnaire-view(?:\.ts)?/);
			assert.ok(loaded.errors[0].error.includes(packedRoot), "failure must identify packed import location");
		} else {
			assert.deepEqual(loaded.errors, [], "absence must not mask an import failure");
			assert.deepEqual(loaded.extensions.map((extension) => extension.resolvedPath),
				control === "selected" ? [packedQuestion] : []);
			if (control === "selected") {
				const extension = loaded.extensions[0];
				assert.equal(extension.path, packedQuestion);
				assert.equal(extension.sourceInfo.path, packedQuestion);
				assert.equal(extension.sourceInfo.origin, "package");
				assert.equal(extension.sourceInfo.scope, "user");
			}
		}
		const created = await createAgentSessionFromServices({
			services, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
		});
		session = created.session;
		assert.equal(session.model?.provider, "unknown");
		assert.equal(session.model?.id, "unknown");
		assert.equal(session.model?.baseUrl, "");
		const live = session;
		const bind = async () => {
			const errors: unknown[] = [];
			await live.bindExtensions({
				mode: "tui",
				uiContext: { ...uiContext, theme: live.extensionRunner.getUIContext().theme },
				onError: (error) => errors.push(error),
			});
			assert.deepEqual(errors, [], "no unexpected startup handler failure");
		};
		await observe(live, bind);
		assertFrozenSource();
		assert.deepEqual(readFileSync(artifact.archivePath), archiveBytes, "archive must remain unchanged");
		verifyIntegrity(readFileSync(artifact.archivePath), artifact.report);
	} finally {
		try {
			session?.dispose();
		} finally {
			process.env = savedEnvironment;
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}

// Serial because owner/environment state is process-global. No model prompts.
test("UM06b2 SDK: packed manifest discovery registers the owned questionnaire", { concurrency: false }, async () => {
	await withSession("selected", async (session, bind) => {
		assertAbsent(session);
		await bind();
		assert.equal(session.getAllTools().filter((tool) => tool.name === toolName).length, 1);
		assert.equal(session.getActiveToolNames().filter((name) => name === toolName).length, 1);
		const definition = session.getToolDefinition(toolName);
		assert.ok(definition);
		assert.equal(definition.name, toolName);
		assert.equal(definition.label, "Ask User Question");
		assert.equal(typeof definition.execute, "function");
		assert.ok(definition.parameters);
	});
});

test("UM06b2 SDK: an empty extension filter prevents questionnaire discovery", { concurrency: false }, async () => {
	await withSession("excluded", async (session, bind) => {
		assertAbsent(session);
		await bind();
		assertAbsent(session);
	});
});

test("UM06b2 SDK: a missing packed relative module fails without source fallback", { concurrency: false }, async () => {
	await withSession("missing-view", async (session, bind) => {
		assertAbsent(session);
		await bind();
		assertAbsent(session);
	});
});
