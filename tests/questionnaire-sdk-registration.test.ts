import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("..", import.meta.url));
const producer = join(root, "extensions", "ask-user-question.ts");
const toolName = "ask_user_question";

// This host provides the public UI boundary, not a rendered terminal.
// Interactive calls are fixture failures; SDK binding may read theme metadata.
// Registration must not ask or render a question.
function unexpectedUI(): never {
	throw new Error("BLOCKED FIXTURE: registration attempted UI interaction");
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

type ExtensionMode = NonNullable<Parameters<AgentSession["bindExtensions"]>[0]["mode"]>;
type OwnerCase = "enabled" | "missing" | "disabled" | "external" | "wrong-home";
interface FixtureOptions {
	owner: OwnerCase;
	incumbent?: boolean;
}

async function withSession(
	options: FixtureOptions,
	observe: (session: AgentSession, bind: (mode: ExtensionMode) => Promise<void>) => Promise<void>,
): Promise<void> {
	const temporary = mkdtempSync(join(tmpdir(), "questionnaire-sdk-"));
	const selectedHome = join(temporary, "selected-agent");
	const sdkHome = join(temporary, "sdk-agent");
	const cwd = join(temporary, "workspace");
	const saved = {
		gentle: process.env.GENTLE_PI_AGENT_HOME,
		pi: process.env.PI_CODING_AGENT_DIR,
	};
	let session: AgentSession | undefined;
	try {
		for (const directory of [selectedHome, sdkHome, cwd]) mkdirSync(directory);
		process.env.GENTLE_PI_AGENT_HOME = selectedHome;
		process.env.PI_CODING_AGENT_DIR = sdkHome;
		assert.notEqual(selectedHome, sdkHome);
		if (options.owner !== "missing") {
			const ownerHome = options.owner === "wrong-home" ? sdkHome : selectedHome;
			mkdirSync(join(ownerHome, "gentle-ai"));
			writeFileSync(join(ownerHome, "gentle-ai", "question-owner.json"), JSON.stringify({
				version: 1,
				owner: options.owner === "external" ? "external" : "gentle-pi",
				enabled: options.owner !== "disabled",
			}));
		}
		const paths = [producer];
		if (options.incumbent) {
			const fixture = join(temporary, "incumbent.mjs");
			// Absolute dependency resolution comes from the frozen source artifact,
			// not nonexistent bare dependencies beside the temporary extension.
			writeFileSync(fixture, `import { Type } from ${JSON.stringify(pathToFileURL(require.resolve("typebox")).href)};
export default function (pi) {
  pi.registerTool({
    name: "ask_user_question", label: "Incumbent",
    description: "Real SDK incumbent control", parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "incumbent" }], details: undefined }),
  });
}
`);
			paths.unshift(fixture);
		}
		const modelRuntime = await ModelRuntime.create({
			authPath: join(sdkHome, "auth.json"),
			modelsPath: join(sdkHome, "models.json"),
			modelsStorePath: join(sdkHome, "models-store.json"),
			refreshOnCreate: false,
		});
		const services = await createAgentSessionServices({
			cwd,
			agentDir: sdkHome,
			modelRuntime,
			settingsManager: SettingsManager.inMemory({}, { projectTrusted: false }),
			resourceLoaderOptions: {
				additionalExtensionPaths: paths,
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		});
		const loaded = services.resourceLoader.getExtensions();
		assert.deepEqual(loaded.errors, [], "BLOCKED LOAD: explicit extensions");
		assert.deepEqual(loaded.extensions.map((extension) => extension.resolvedPath), paths);
		assert.deepEqual(services.diagnostics, [], "BLOCKED SERVICES: diagnostics");
		assert.deepEqual(services.resourceLoader.getSkills().skills, []);
		assert.deepEqual(services.resourceLoader.getPrompts().prompts, []);
		assert.deepEqual(services.resourceLoader.getThemes().themes, []);
		assert.deepEqual(services.resourceLoader.getAgentsFiles().agentsFiles, []);
		assert.equal(services.settingsManager.isProjectTrusted(), false);
		assert.equal(modelRuntime.getAvailableSnapshot().length, 0);
		const created = await createAgentSessionFromServices({
			services, sessionManager: SessionManager.inMemory(cwd), noTools: "builtin",
		});
		session = created.session;
		// Agent core supplies an unknown-model sentinel for this empty runtime.
		assert.equal(session.model?.provider, "unknown", "BLOCKED FIXTURE: SDK default model");
		assert.equal(session.model?.id, "unknown");
		assert.equal(session.model?.baseUrl, "");
		const live = session;
		const bind = async (mode: ExtensionMode) => {
			const errors: unknown[] = [];
			await live.bindExtensions({
				mode, uiContext: { ...uiContext, theme: live.extensionRunner.getUIContext().theme },
				onError: (error) => errors.push(error),
			});
			assert.deepEqual(errors, [], "BLOCKED LIFECYCLE: extension handler error");
		};
		await observe(live, bind);
	} finally {
		try {
			session?.dispose();
		} finally {
			if (saved.gentle === undefined) delete process.env.GENTLE_PI_AGENT_HOME;
			else process.env.GENTLE_PI_AGENT_HOME = saved.gentle;
			if (saved.pi === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved.pi;
			rmSync(temporary, { recursive: true, force: true });
		}
	}
}

function assertAbsent(session: AgentSession): void {
	assert.equal(session.getAllTools().some((tool) => tool.name === toolName), false);
	assert.equal(session.getActiveToolNames().includes(toolName), false);
	assert.equal(session.getToolDefinition(toolName), undefined);
}

// All cases are serial: the selected owner is process environment state.
test("UM06a SDK: enabled selected owner registers only at TUI bind and remains unique", async () => {
	await withSession({ owner: "enabled" }, async (session, bind) => {
		assertAbsent(session);
		await bind("tui");
		assert.equal(session.getAllTools().filter((tool) => tool.name === toolName).length, 1);
		assert.equal(session.getActiveToolNames().filter((name) => name === toolName).length, 1);
		const definition = session.getToolDefinition(toolName);
		assert.ok(definition);
		assert.equal(definition.name, toolName);
		assert.equal(definition.label, "Ask User Question");
		assert.equal(typeof definition.execute, "function");
		assert.ok(definition.parameters);
		await bind("tui");
		assert.strictEqual(session.getToolDefinition(toolName), definition);
		assert.equal(session.getAllTools().filter((tool) => tool.name === toolName).length, 1);
		assert.equal(session.getActiveToolNames().filter((name) => name === toolName).length, 1);
	});
});

for (const owner of ["missing", "disabled", "external", "wrong-home"] as const) {
	test(`UM06a SDK: ${owner} owner does not register`, async () => {
		await withSession({ owner }, async (session, bind) => {
			assertAbsent(session);
			await bind("tui");
			assertAbsent(session);
		});
	});
}

for (const mode of ["json", "rpc"] as const) {
	test(`UM06a SDK: enabled owner does not register in ${mode} mode`, async () => {
		await withSession({ owner: "enabled" }, async (session, bind) => {
			assertAbsent(session);
			await bind(mode);
			assertAbsent(session);
		});
	});
}

test("UM06a SDK: inactive configured incumbent is retained without replacement", async () => {
	await withSession({ owner: "enabled", incumbent: true }, async (session, bind) => {
		const incumbent = session.getToolDefinition(toolName);
		assert.ok(incumbent);
		assert.equal(incumbent.label, "Incumbent");
		session.setActiveToolsByName([]);
		assert.equal(session.getActiveToolNames().includes(toolName), false);
		assert.equal(session.getAllTools().filter((tool) => tool.name === toolName).length, 1);
		await bind("tui");
		assert.strictEqual(session.getToolDefinition(toolName), incumbent);
		assert.equal(session.getAllTools().filter((tool) => tool.name === toolName).length, 1);
		assert.equal(session.getActiveToolNames().includes(toolName), false);
	});
});
