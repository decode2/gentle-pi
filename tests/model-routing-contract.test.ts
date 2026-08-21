import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AuthStorage, DefaultResourceLoader, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { getModel, getProviders } from "@earendil-works/pi-ai";
import { modelConfigPath, resolveModelRoutingTarget, writeModelConfigFile } from "../lib/model-routing-authority.ts";
import {
	MODEL_ROUTING_CONTRACT,
	capabilities,
	inspectModelRouting,
	validateModelRouting,
	type ModelRoutingModelRuntime,
} from "../lib/model-routing-contract.ts";

function scratch(): { cwd: string; agentDir: string; globalDir: string; dispose: () => void } {
	const root = mkdtempSync(join(tmpdir(), "gentle-pi-model-routing-contract-"));
	const cwd = join(root, "project"), agentDir = join(root, "agent"), globalDir = join(root, "global");
	mkdirSync(cwd, { recursive: true });
	return { cwd, agentDir, globalDir, dispose: () => rmSync(root, { recursive: true, force: true }) };
}

function model(provider: string, id: string, reasoning = true): Record<string, unknown> {
	return { provider, id, name: id, api: "openai-completions", baseUrl: "https://example.invalid", reasoning, input: ["text"], contextWindow: 1000, maxTokens: 100, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, ...(reasoning ? { thinkingLevelMap: { max: null } } : {}) };
}

function runtime(): ModelRoutingModelRuntime {
	const catalog = model("demo", "catalog");
	const operational = model("demo", "operational");
	const models = [catalog, operational];
	return {
		getProviders: () => ["demo"],
		getAll: () => models,
		getAvailable: () => [operational],
		find: (provider, id) => models.find((entry) => entry.provider === provider && entry.id === id),
	};
}

test("negotiates contract v1 and supported operations", () => {
	assert.deepEqual(capabilities({ contract: MODEL_ROUTING_CONTRACT }), {
		contract: MODEL_ROUTING_CONTRACT,
		supported: true,
		operations: ["capabilities", "inspect", "validate", "apply"],
	});
	assert.equal(capabilities({ contract: "gentle-pi.model-routing/v2" }).supported, false);
});

test("inspect reports provenance, inherit state, discovered agents, and catalog/auth distinction", async () => {
	const target = scratch();
	try {
		mkdirSync(join(target.agentDir, "agents"), { recursive: true });
		writeFileSync(join(target.agentDir, "agents", "worker.md"), "name: worker\ndescription: test\n");
		const globalPath = resolveModelRoutingTarget(target.cwd, "global", { configHome: target.globalDir, agentHome: target.agentDir }).configPath;
		writeModelConfigFile(globalPath, { worker: { model: "demo/operational", thinking: "high" }, idle: "inherit" });
		const projectPath = resolveModelRoutingTarget(target.cwd, "project", { configHome: target.globalDir, agentHome: target.agentDir }).configPath;
		writeModelConfigFile(projectPath, { projectWorker: { model: "demo/operational" } });
		const result = await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "global", configHome: target.globalDir }, { runtime: runtime(), discoverAgents: () => [{ name: "worker", source: "user", filePath: join(target.agentDir, "agents", "worker.md") }] });
		assert.equal(result.context?.cwd, target.cwd);
		assert.equal(result.context?.agentDir, target.agentDir);
		assert.equal(result.context?.target, "global");
		assert.equal(result.targets.global.provenance.source, "global");
		assert.equal(result.targets.project.provenance.configPath, projectPath);
		const project = await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", configHome: target.globalDir }, { runtime: runtime() });
		assert.deepEqual(project.assignments.projectWorker, { model: "demo/operational", thinking: undefined, inheritModel: false, inheritThinking: true });
		assert.deepEqual(result.assignments.worker, { model: "demo/operational", thinking: "high", inheritModel: false, inheritThinking: false });
		assert.deepEqual(result.assignments.idle, { model: undefined, thinking: undefined, inheritModel: true, inheritThinking: true });
		assert.equal(result.agents.find((entry) => entry.name === "worker")?.source, "user");
		const catalogModel = result.models.find((entry) => entry.canonicalId === "demo/catalog");
		assert.equal(catalogModel?.catalog, true);
		assert.equal(catalogModel?.configured, false);
		assert.equal(catalogModel?.authConfigured, false);
		assert.equal(catalogModel?.available, false);
		assert.equal(catalogModel?.authenticated, "unknown");
		assert.equal(catalogModel?.operational, "unknown");
		assert.equal(catalogModel?.availability, "catalog");
		const operationalModel = result.models.find((entry) => entry.canonicalId === "demo/operational");
		assert.equal(operationalModel?.configured, true);
		assert.equal(operationalModel?.authConfigured, true);
		assert.equal(operationalModel?.available, true);
		assert.equal(operationalModel?.authenticated, "unknown");
		assert.equal(operationalModel?.operational, "unknown");
		assert.equal(operationalModel?.availability, "configured");
		assert.deepEqual(operationalModel?.supportedThinkingLevels, ["off", "minimal", "low", "medium", "high"]);
	} finally { target.dispose(); }
});

test("validate is read-only and rejects contract, draft, unavailable model, and thinking errors", async () => {
	const target = scratch(), runtimeSource = runtime();
	try {
		const path = modelConfigPath(target.cwd, "project");
		writeModelConfigFile(path, { worker: { model: "demo/operational", thinking: "high" } });
		const before = readFileSync(path, "utf8");
		const unsupported = await validateModelRouting({ contract: "gentle-pi.model-routing/v2", cwd: target.cwd, agentDir: target.agentDir, target: "project", draft: {} }, { runtime: runtimeSource });
		assert.equal(unsupported.ok, false);
		assert.deepEqual(unsupported.diagnostics.map(({ code, path }) => ({ code, path })), [{ code: "unsupported-contract", path: "contract" }]);
		const malformed = await validateModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", draft: null }, { runtime: runtimeSource });
		assert.equal(malformed.ok, false);
		assert.deepEqual(malformed.diagnostics.map(({ code, path }) => ({ code, path })), [{ code: "malformed-draft", path: "draft" }]);
		const unavailable = await validateModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", draft: { worker: { model: "demo/catalog" } } }, { runtime: runtimeSource });
		assert.equal(unavailable.ok, false);
		assert.deepEqual(unavailable.diagnostics.map(({ code, path }) => ({ code, path })), [{ code: "model-unavailable", path: "worker.model" }]);
		const thinking = await validateModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", draft: { worker: { model: "demo/operational", thinking: "max" } } }, { runtime: runtimeSource });
		assert.equal(thinking.ok, false);
		assert.deepEqual(thinking.diagnostics.map(({ code, path }) => ({ code, path })), [{ code: "thinking-unsupported", path: "worker.thinking" }]);
		const valid = await validateModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", draft: { worker: { model: "demo/operational", thinking: "high" } } }, { runtime: runtimeSource });
		assert.equal(valid.ok, true);
		assert.equal(readFileSync(path, "utf8"), before);
	} finally { target.dispose(); }
});

test("does not refresh by default and matches the installed Pi SDK surface", async () => {
	const target = scratch(), auth = AuthStorage.inMemory({ anthropic: { type: "api_key", key: "test" } });
	try {
		const registry = ModelRegistry.inMemory(auth), available = registry.getAvailable();
		assert.ok(getProviders().includes("anthropic"));
		assert.ok(getModel("anthropic", available[0]?.id ?? "") || available.length === 0);
		assert.equal(typeof DefaultResourceLoader, "function");
		let refreshed = false;
		const source: ModelRoutingModelRuntime = { ...runtime(), refresh: () => { refreshed = true; } };
		await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project" }, { runtime: source });
		assert.equal(refreshed, false);
	} finally { target.dispose(); }
});

test("requires explicit cwd, agentDir, and target inputs", async () => {
	const target = scratch();
	try {
		const inspection = await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: "", agentDir: "", target: undefined as never }, { runtime: runtime() });
		assert.deepEqual(inspection.diagnostics.map(({ code, path }) => ({ code, path })), [
			{ code: "missing-cwd", path: "cwd" },
			{ code: "missing-agent-dir", path: "agentDir" },
			{ code: "missing-target", path: "target" },
		]);
		const validation = await validateModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, draft: {} } as never, { runtime: runtime() });
		assert.deepEqual(validation.diagnostics.map(({ code, path }) => ({ code, path })), [{ code: "missing-target", path: "target" }]);
	} finally { target.dispose(); }
});

test("default adapter reads auth snapshots without creating missing paths", async () => {
	const target = scratch();
	try {
		assert.equal(capabilities({ contract: MODEL_ROUTING_CONTRACT }).supported, true);
		const inspected = await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", configHome: target.globalDir });
		const validated = await validateModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", configHome: target.globalDir, draft: {} });
		assert.ok(inspected.models.length > 0);
		assert.equal(validated.ok, true);
		assert.equal(existsSync(join(target.agentDir, "auth.json")), false);
		assert.equal(existsSync(target.agentDir), false);
		assert.equal(existsSync(target.globalDir), false);
	} finally { target.dispose(); }
});

test("default adapter exercises the installed SDK catalog without claiming authentication", async () => {
	const target = scratch();
	try {
		const result = await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", configHome: target.globalDir });
		assert.ok(result.providers.includes("anthropic"));
		const anthropic = result.models.find((entry) => entry.provider === "anthropic");
		assert.equal(anthropic?.catalog, true);
		assert.equal(anthropic?.authenticated, "unknown");
		assert.equal(anthropic?.operational, "unknown");
	} finally { target.dispose(); }
});

test("refresh timeout aborts the underlying operation", async () => {
	const target = scratch();
	let refreshSignal: AbortSignal | undefined;
	try {
		const source: ModelRoutingModelRuntime = {
			...runtime(),
			refresh: ({ signal } = {}) => new Promise<void>((resolve) => {
				refreshSignal = signal;
				signal?.addEventListener("abort", () => resolve(), { once: true });
			}),
		};
		const result = await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", refresh: { enabled: true, timeoutMs: 10 } }, { runtime: source });
		assert.equal(refreshSignal?.aborted, true);
		assert.deepEqual(result.diagnostics.filter(({ code }) => code === "refresh-timeout").map(({ path }) => path), ["refresh"]);
	} finally { target.dispose(); }
});

test("caller cancellation aborts refresh with a stable diagnostic and no mutation", async () => {
	const target = scratch(), caller = new AbortController(), source = runtime(), before = structuredClone(await source.getAll!());
	let refreshSignal: AbortSignal | undefined, started!: () => void;
	const refreshStarted = new Promise<void>((resolve) => { started = resolve; });
	try {
		const refreshSource: ModelRoutingModelRuntime = {
			...source,
			refresh: ({ signal } = {}) => { refreshSignal = signal; started(); return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true })); },
		};
		const resultPromise = inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project", refresh: { enabled: true, signal: caller.signal, timeoutMs: 5_000 } }, { runtime: refreshSource });
		await refreshStarted; caller.abort();
		const result = await resultPromise;
		assert.equal(refreshSignal?.aborted, true);
		assert.deepEqual(result.diagnostics.filter(({ code }) => code === "refresh-cancelled"), [{ code: "refresh-cancelled", message: "Model refresh was cancelled.", severity: "warning", path: "refresh" }]);
		assert.equal(result.diagnostics.some(({ code }) => code === "refresh-timeout" || code === "refresh-failed"), false);
		assert.deepEqual(await source.getAll!(), before);
		assert.equal(existsSync(target.agentDir), false);
		assert.equal(existsSync(modelConfigPath(target.cwd, "project")), false);
	} finally { target.dispose(); }
});

test("reports read-only runtime failures with a stable diagnostic", async () => {
	const target = scratch();
	try {
		const source: ModelRoutingModelRuntime = {
			...runtime(),
			getAvailable: () => { throw new Error("credential backend is read-only"); },
		};
		const result = await inspectModelRouting({ contract: MODEL_ROUTING_CONTRACT, cwd: target.cwd, agentDir: target.agentDir, target: "project" }, { runtime: source });
		assert.deepEqual(result.diagnostics.filter(({ code }) => code === "runtime-read-only-failure").map(({ code, path }) => ({ code, path })), [{ code: "runtime-read-only-failure", path: "runtime" }]);
	} finally { target.dispose(); }
});
