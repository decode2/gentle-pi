import assert from "node:assert/strict";
import {
	existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync,
	rmSync, unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
	extractArtifact, frozenModules, gitBlob, loadArtifact,
	verifyExtraction, verifyIntegrity,
} from "./fixtures/questionnaire-packed-artifact.ts";

// Expected SDK 1.0 baseline only. No invocation of tool or renderer is permitted.
const sdkPackage = "@earendil-works/pi-coding-agent";
const question = "extensions/ask-user-question.ts";
const view = "lib/questionnaire/questionnaire-view.ts";
const toolName = "ask_user_question";
const sourceRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
type Control = "selected" | "excluded" | "missing-view";

function assertSDKVersion(): void {
	// The root ESM export is public; package.json is not an exported subpath.
	const entry = new URL(import.meta.resolve(sdkPackage));
	assert.ok(entry.pathname.endsWith("/dist/index.js"));
	const metadata = JSON.parse(readFileSync(new URL("../package.json", entry), "utf8"));
	assert.equal(metadata.name, sdkPackage);
	assert.equal(metadata.version, "1.0.0");
}

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
	observe: (session: AgentSession) => void,
): Promise<void> {
	// The future launcher must use env -i and offline containment. Scrubbing here
	// precedes even the first dynamic SDK import; no ambient credential is read.
	const artifactDirectory = process.env.PACK_ARTIFACT_DIR;
	assert.ok(artifactDirectory && isAbsolute(artifactDirectory), "absolute PACK_ARTIFACT_DIR required");
	const savedEnvironment = { ...process.env };
	const temporary = mkdtempSync(join(tmpdir(), "questionnaire-pi1-packed-"));
	const packedRoot = join(temporary, "package");
	const cwd = join(temporary, "workspace");
	const home = join(temporary, "home");
	const sdkHome = join(temporary, "sdk-agent");
	const selectedHome = join(temporary, "selected-agent");
	const configHome = join(temporary, "config");
	const cacheHome = join(temporary, "cache");
	const dataHome = join(temporary, "data");
	const stateHome = join(temporary, "state");
	let session: AgentSession | undefined;
	try {
		for (const directory of [cwd, home, sdkHome, selectedHome,
			configHome, cacheHome, dataHome, stateHome]) mkdirSync(directory);
		process.env = {
			PATH: savedEnvironment.PATH,
			HOME: home,
			TMPDIR: temporary,
			XDG_CONFIG_HOME: configHome,
			XDG_CACHE_HOME: cacheHome,
			XDG_DATA_HOME: dataHome,
			XDG_STATE_HOME: stateHome,
			GENTLE_PI_AGENT_HOME: selectedHome,
			PI_CODING_AGENT_DIR: sdkHome,
		};
		assert.deepEqual(Object.keys(process.env).sort(), [
			"PATH", "HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME",
			"XDG_DATA_HOME", "XDG_STATE_HOME", "GENTLE_PI_AGENT_HOME",
			"PI_CODING_AGENT_DIR",
		].sort());
		assert.notEqual(selectedHome, sdkHome);
		assertSDKVersion();
		const {
			createAgentSessionServices, createAgentSessionFromServices,
			ModelRuntime, SettingsManager, SessionManager,
		} = await import("@earendil-works/pi-coding-agent");

		// Every case independently authenticates and extracts a pristine archive.
		const artifact = loadArtifact(artifactDirectory);
		const archiveBytes = readFileSync(artifact.archivePath);
		extractArtifact(artifact, packedRoot);
		verifyExtraction(packedRoot, artifact.report);
		assertFrozenSource();
		const packedQuestion = join(packedRoot, question);
		const packedView = join(packedRoot, view);
		assert.ok(realpathSync(packedQuestion).startsWith(realpathSync(packedRoot) + sep));
		assert.ok(realpathSync(packedView).startsWith(realpathSync(packedRoot) + sep));
		assert.equal(existsSync(join(packedRoot, "node_modules")), false);
		if (control === "missing-view") {
			// Only this verified packed member is deliberately removed.
			unlinkSync(packedView);
			assert.equal(existsSync(packedView), false);
			assertFrozenSource();
		}

		const settingsManager = SettingsManager.inMemory({
			packages: [{
				source: packedRoot,
				extensions: control === "excluded" ? [] : [question],
				skills: [], prompts: [], themes: [],
			}],
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(sdkHome, "auth.json"),
			modelsPath: join(sdkHome, "models.json"),
			modelsStorePath: join(cacheHome, "models-store.json"),
			allowModelNetwork: false,
			refreshOnCreate: false,
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir: sdkHome,
			settingsManager,
			modelRuntime,
			resourceLoaderOptions: {
				noExtensions: false,
				noContextFiles: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		});
		const loaded = services.resourceLoader.getExtensions();
		if (control === "missing-view") {
			assert.deepEqual(loaded.extensions, []);
			assert.equal(loaded.errors.length, 1, "only the packed producer may fail");
			assert.equal(loaded.errors[0].path, packedQuestion);
			assert.equal(typeof loaded.errors[0].error, "string");
			assert.ok(loaded.errors[0].error.trim().length > 0);
		} else {
			assert.deepEqual(loaded.errors, [], "absence must not conceal loader failure");
			assert.deepEqual(
				loaded.extensions.map((extension) => extension.resolvedPath),
				control === "selected" ? [packedQuestion] : [],
			);
			if (control === "selected") {
				const extension = loaded.extensions[0];
				assert.equal(extension.path, packedQuestion);
				assert.equal(extension.sourceInfo.path, packedQuestion);
				assert.equal(extension.sourceInfo.origin, "package");
			}
		}

		const created = await createAgentSessionFromServices({
			services,
			sessionManager: SessionManager.inMemory(cwd),
			noTools: "builtin",
		});
		session = created.session;
		const live = session;
		const interactions: PropertyKey[] = [];
		const errors: unknown[] = [];
		// The public typed target supplies Theme metadata without constructing an
		// incomplete UI interface. Even a swallowed forbidden access is recorded.
		const uiContext = new Proxy(live.extensionRunner.getUIContext(), {
			get(target, key) {
				if (key === "theme") return Reflect.get(target, key, target);
				interactions.push(key);
				throw new Error(`Discovery attempted UI access: ${String(key)}`);
			},
			set(_target, key) {
				interactions.push(key);
				throw new Error(`Discovery attempted UI mutation: ${String(key)}`);
			},
		});
		await live.bindExtensions({
			mode: "tui",
			uiContext,
			onError: (error) => { errors.push(error); },
		});
		assert.deepEqual(errors, [], "startup extension errors are fatal to this fixture");
		assert.deepEqual(interactions, [], "no UI interaction during discovery/binding");
		observe(live);
		assert.deepEqual(interactions, []);
		assertFrozenSource();
		assert.deepEqual(readFileSync(artifact.archivePath), archiveBytes);
		verifyIntegrity(readFileSync(artifact.archivePath), artifact.report);
	} finally {
		try {
			// Public SDK 1.0 disposal is synchronous, including failed observations.
			session?.dispose();
		} finally {
			process.env = savedEnvironment;
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}

// Serial: process environment is global. No model/provider/prompt call is made.
// These are selective package/filter checks, not full autoload or human TUI proof.
test("UM07b SDK 1.0: selected packed questionnaire has one live definition", { concurrency: false }, async () => {
	await withSession("selected", (session) => {
		assert.equal(session.getAllTools().filter((tool) => tool.name === toolName).length, 1);
		assert.equal(session.getActiveToolNames().filter((name) => name === toolName).length, 1);
		const definition = session.getToolDefinition(toolName);
		assert.ok(definition);
		assert.equal(definition.name, toolName);
		assert.equal(typeof definition.execute, "function");
		assert.equal(typeof definition.renderCall, "function");
		assert.equal(typeof definition.renderResult, "function");
		// Presence only: never execute, render, dispatch, or request custom UI.
	});
});

test("UM07b SDK 1.0: empty package extension filter excludes questionnaire", { concurrency: false }, async () => {
	await withSession("excluded", assertAbsent);
});

test("UM07b SDK 1.0: missing packed view reports producer error without fallback", { concurrency: false }, async () => {
	await withSession("missing-view", assertAbsent);
});
