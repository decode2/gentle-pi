import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage, DefaultResourceLoader, ModelRegistry, type AuthStorageBackend } from "@earendil-works/pi-coding-agent";
import { getModel, getModels, getProviders, getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { THINKING_LEVELS, normalizeModelConfig, normalizeModelId, readModelConfigFileAsync, resolveModelRoutingTarget, type AgentModelConfig, type AgentRoutingEntry, type ModelConfigTarget, type ModelRoutingRoots, type ThinkingLevel } from "./model-routing-authority.ts";
import type { AgentEntry, ModelRoutingAgentDiscovery } from "./model-routing-agents.ts";

export const MODEL_ROUTING_CONTRACT = "gentle-pi.model-routing/v1" as const;
export const MODEL_ROUTING_OPERATIONS = ["capabilities", "inspect", "validate"] as const;
export type ModelRoutingOperation = (typeof MODEL_ROUTING_OPERATIONS)[number];
export type ModelRoutingDiagnostic = { code: string; message: string; severity: "error" | "warning" | "info"; path?: string };
export type ModelRoutingSdkModel = Record<string, unknown>;
export interface ModelRoutingModelRuntime {
	getProviders?: () => readonly unknown[] | Promise<readonly unknown[]>;
	getAll?: () => readonly ModelRoutingSdkModel[] | Promise<readonly ModelRoutingSdkModel[]>;
	/** Configured-auth availability; this does not prove live authentication. */
	getAvailable: () => readonly ModelRoutingSdkModel[] | Promise<readonly ModelRoutingSdkModel[]>;
	find?: (provider: string, id: string) => ModelRoutingSdkModel | undefined | Promise<ModelRoutingSdkModel | undefined>;
	refresh?: (options?: { signal?: AbortSignal }) => void | Promise<void>;
}
export interface ModelRoutingDependencies {
	runtime?: ModelRoutingModelRuntime;
	createRuntime?: (context: ModelRoutingContext, loadExtensions: boolean) => ModelRoutingModelRuntime | Promise<ModelRoutingModelRuntime>;
	discoverAgents?: ModelRoutingAgentDiscovery;
}
export interface ModelRoutingRequest {
	contract?: unknown;
	cwd: string;
	agentDir: string;
	target: ModelConfigTarget;
	configHome?: string;
	loadExtensions?: boolean;
	refresh?: { enabled: true; signal?: AbortSignal; timeoutMs?: number };
}
export interface ModelRoutingContext { cwd: string; agentDir: string; target: ModelConfigTarget; global: ReturnType<typeof resolveModelRoutingTarget>; project: ReturnType<typeof resolveModelRoutingTarget> }
export interface ModelRoutingCapabilities { contract: typeof MODEL_ROUTING_CONTRACT; supported: boolean; operations: readonly ModelRoutingOperation[] }
export interface ModelRoutingAssignment { model: string | undefined; thinking: ThinkingLevel | undefined; inheritModel: boolean; inheritThinking: boolean }
export interface ModelRoutingTargetInspection {
	provenance: { target: ModelConfigTarget; source: "global" | "project" | "missing" | "invalid"; status: "valid" | "missing" | "invalid"; configPath: string; profilePath: string };
	assignments: Record<string, ModelRoutingAssignment>;
}
export interface ModelRoutingAgent extends AgentEntry { configurable: true; assignment?: ModelRoutingAssignment }
export interface ModelRoutingModel {
	canonicalId: string; provider: string; modelId: string; name: string; api?: string;
	catalog: true; configured: boolean; authConfigured: boolean; available: boolean; authenticated: boolean | "unknown"; operational: "authenticated" | "unavailable" | "unknown"; availability: "catalog" | "configured" | "authenticated" | "unknown";
	reasoning: boolean; supportedThinkingLevels?: readonly string[];
	capabilities: { reasoning: boolean; input: readonly string[]; contextWindow?: number; maxTokens?: number; thinkingLevels?: readonly string[] };
}
export interface ModelRoutingInspection {
	contract: typeof MODEL_ROUTING_CONTRACT; context?: ModelRoutingContext; targets: Partial<Record<ModelConfigTarget, ModelRoutingTargetInspection>>;
	assignments: Record<string, ModelRoutingAssignment>; agents: ModelRoutingAgent[]; providers: string[]; models: ModelRoutingModel[]; diagnostics: ModelRoutingDiagnostic[];
}
export interface ModelRoutingValidationRequest extends ModelRoutingRequest { draft: unknown }
export interface ModelRoutingValidationResult { contract: typeof MODEL_ROUTING_CONTRACT; ok: boolean; diagnostics: ModelRoutingDiagnostic[] }

const diag = (code: string, message: string, severity: ModelRoutingDiagnostic["severity"] = "error", path?: string): ModelRoutingDiagnostic => ({ code, message, severity, ...(path ? { path } : {}) });
const object = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const supportedContract = (value: unknown): boolean => value === undefined || value === MODEL_ROUTING_CONTRACT;
const runtimeFailure = (diagnostics: ModelRoutingDiagnostic[], path = "runtime") => diagnostics.push(diag("runtime-read-only-failure", "A read-only model runtime operation failed.", "error", path));

export function capabilities(request: { contract?: unknown } = {}): ModelRoutingCapabilities { return { contract: MODEL_ROUTING_CONTRACT, supported: supportedContract(request.contract), operations: MODEL_ROUTING_OPERATIONS }; }
function requestDiagnostics(request: Partial<ModelRoutingRequest>): ModelRoutingDiagnostic[] {
	const diagnostics: ModelRoutingDiagnostic[] = [];
	if (typeof request.cwd !== "string" || !request.cwd.trim()) diagnostics.push(diag("missing-cwd", "cwd is required explicitly.", "error", "cwd"));
	if (typeof request.agentDir !== "string" || !request.agentDir.trim()) diagnostics.push(diag("missing-agent-dir", "agentDir is required explicitly.", "error", "agentDir"));
	if (request.target === undefined) diagnostics.push(diag("missing-target", "target is required explicitly.", "error", "target"));
	else if (request.target !== "global" && request.target !== "project") diagnostics.push(diag("invalid-target", "target must be global or project.", "error", "target"));
	return diagnostics;
}
function contextOf(request: ModelRoutingRequest, diagnostics: ModelRoutingDiagnostic[]): ModelRoutingContext | undefined {
	const inputErrors = requestDiagnostics(request); diagnostics.push(...inputErrors); if (inputErrors.length) return undefined;
	const roots: ModelRoutingRoots = { agentHome: request.agentDir, ...(request.configHome !== undefined ? { configHome: request.configHome } : {}) };
	return { cwd: request.cwd, agentDir: request.agentDir, target: request.target, global: resolveModelRoutingTarget(request.cwd, "global", roots), project: resolveModelRoutingTarget(request.cwd, "project", roots) };
}
function savedAssignment(entry: AgentRoutingEntry | undefined): ModelRoutingAssignment { return { model: entry?.model, thinking: entry?.thinking, inheritModel: !entry?.model, inheritThinking: !entry?.thinking }; }
async function target(context: ModelRoutingContext, name: ModelConfigTarget): Promise<ModelRoutingTargetInspection> {
	const resolved = context[name], result = await readModelConfigFileAsync(resolved.configPath), status = result.status;
	if (status !== "valid") return { provenance: { target: name, source: status === "missing" ? "missing" : "invalid", status, configPath: resolved.configPath, profilePath: resolved.profilePath }, assignments: {} };
	return { provenance: { target: name, source: name, status, configPath: resolved.configPath, profilePath: resolved.profilePath }, assignments: Object.fromEntries(Object.entries(result.config).map(([agent, entry]) => [agent, savedAssignment(entry)])) };
}
function canonical(value: unknown): string | undefined { return object(value) && typeof value.provider === "string" && typeof value.id === "string" ? normalizeModelId(`${value.provider}/${value.id}`) : undefined; }
function provider(value: unknown): string | undefined { return object(value) && typeof value.provider === "string" ? value.provider : undefined; }
function parts(id: string): [string, string] | undefined { const slash = id.indexOf("/"); return slash > 0 && slash < id.length - 1 ? [id.slice(0, slash), id.slice(slash + 1)] : undefined; }
function descriptor(value: ModelRoutingSdkModel, configuredIds: Set<string>): ModelRoutingModel | undefined {
	const canonicalId = canonical(value), providerId = provider(value); if (!canonicalId || !providerId) return undefined;
	let levels: readonly string[] | undefined;
	try { levels = getSupportedThinkingLevels(value as never); } catch { const map = object(value.thinkingLevelMap) ? value.thinkingLevelMap : undefined; levels = map ? THINKING_LEVELS.filter((level) => map[level] !== null) : value.reasoning === true ? ["off", "minimal", "low", "medium", "high", "xhigh"] : ["off"]; }
	const configured = configuredIds.has(canonicalId), reasoning = value.reasoning === true, input = Array.isArray(value.input) ? value.input.filter((entry): entry is string => typeof entry === "string") : [];
	return { canonicalId, provider: providerId, modelId: value.id as string, name: typeof value.name === "string" ? value.name : value.id as string, api: typeof value.api === "string" ? value.api : undefined, catalog: true, configured, authConfigured: configured, available: configured, authenticated: "unknown", operational: "unknown", availability: configured ? "configured" : "catalog", reasoning, supportedThinkingLevels: levels, capabilities: { reasoning, input, contextWindow: typeof value.contextWindow === "number" ? value.contextWindow : undefined, maxTokens: typeof value.maxTokens === "number" ? value.maxTokens : undefined, thinkingLevels: levels } };
}
function snapshot(path: string): string | undefined {
	try { return readFileSync(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function readonlyAuthStorage(path: string): AuthStorage {
	const backend: AuthStorageBackend = {
		withLock<T>(fn) { const result = fn(snapshot(path)); if (result.next !== undefined) throw new Error("read-only auth storage cannot persist credentials"); return result.result; },
		async withLockAsync<T>(fn) { const result = await fn(snapshot(path)); if (result.next !== undefined) throw new Error("read-only auth storage cannot persist credentials"); return result.result; },
	};
	return AuthStorage.fromStorage(backend);
}
async function runtime(context: ModelRoutingContext, request: ModelRoutingRequest, dependencies: ModelRoutingDependencies, diagnostics: ModelRoutingDiagnostic[]): Promise<ModelRoutingModelRuntime> {
	if (dependencies.runtime) return dependencies.runtime;
	if (dependencies.createRuntime) return await dependencies.createRuntime(context, request.loadExtensions === true);
	const authPath = join(context.agentDir, "auth.json"), auth = readonlyAuthStorage(authPath), registry = ModelRegistry.create(auth, join(context.agentDir, "models.json"));
	if (auth.drainErrors().length) runtimeFailure(diagnostics, authPath);
	if (request.loadExtensions) {
		try { await new DefaultResourceLoader({ cwd: context.cwd, agentDir: context.agentDir }).reload(); } catch { runtimeFailure(diagnostics); }
	}
	return { getProviders: () => getProviders(), getAll: () => registry.getAll() as unknown as ModelRoutingSdkModel[], getAvailable: () => registry.getAvailable() as unknown as ModelRoutingSdkModel[], find: (p, id) => registry.find(p, id) as unknown as ModelRoutingSdkModel | undefined };
}
async function safe<T>(operation: () => T | Promise<T>, diagnostics: ModelRoutingDiagnostic[]): Promise<T | undefined> { try { return await operation(); } catch { runtimeFailure(diagnostics); return undefined; } }
async function refresh(source: ModelRoutingModelRuntime, request: ModelRoutingRequest, diagnostics: ModelRoutingDiagnostic[]): Promise<void> {
	const refreshRequest = request.refresh; if (!refreshRequest?.enabled) return;
	if (!source.refresh) { diagnostics.push(diag("refresh-unsupported", "The model runtime has no explicit refresh operation.", "error", "refresh")); return; }
	const timeout = Math.min(Math.max(refreshRequest.timeoutMs ?? 2_000, 1), 5_000), caller = refreshRequest.signal;
	if (caller?.aborted) { diagnostics.push(diag("refresh-cancelled", "Model refresh was cancelled.", "warning", "refresh")); return; }
	const controller = new AbortController();
	await new Promise<void>((resolve) => {
		let done = false, timer: ReturnType<typeof setTimeout>;
		const onAbort = () => { if (done) return; controller.abort(caller?.reason); diagnostics.push(diag("refresh-cancelled", "Model refresh was cancelled.", "warning", "refresh")); finish(); };
		const finish = () => { if (done) return; done = true; clearTimeout(timer); caller?.removeEventListener("abort", onAbort); resolve(); };
		timer = setTimeout(() => { if (done) return; controller.abort(); diagnostics.push(diag("refresh-timeout", `Model refresh exceeded ${timeout}ms.`, "error", "refresh")); finish(); }, timeout);
		caller?.addEventListener("abort", onAbort, { once: true });
		Promise.resolve().then(() => source.refresh!({ signal: controller.signal })).then(() => finish(), (error) => { if (!done) diagnostics.push(diag("refresh-failed", error instanceof Error ? error.message : String(error), "error", "refresh")); finish(); });
	});
}
async function catalog(source: ModelRoutingModelRuntime, diagnostics: ModelRoutingDiagnostic[]): Promise<{ raw: ModelRoutingSdkModel[]; models: ModelRoutingModel[]; providers: string[] }> {
	const configured = new Set((await safe(() => source.getAvailable(), diagnostics) ?? []).map(canonical).filter((id): id is string => !!id)), raw = source.getAll ? [...(await safe(() => source.getAll(), diagnostics) ?? [])] : [];
	if (!raw.length) for (const entry of (await safe(() => source.getProviders ? source.getProviders() : getProviders(), diagnostics) ?? [])) { const name = typeof entry === "string" ? entry : provider(entry); if (name) try { raw.push(...getModels(name as never) as unknown as ModelRoutingSdkModel[]); } catch { /* custom provider */ } }
	const models = raw.map((entry) => descriptor(entry, configured)).filter((entry): entry is ModelRoutingModel => !!entry).sort((a, b) => a.canonicalId.localeCompare(b.canonicalId));
	const providerIds = await safe(() => source.getProviders ? source.getProviders() : getProviders(), diagnostics), providers = [...new Set([...(providerIds ?? []).map((entry) => typeof entry === "string" ? entry : provider(entry)).filter((entry): entry is string => !!entry), ...models.map((entry) => entry.provider)])].sort();
	return { raw, models, providers };
}
async function resolveModel(source: ModelRoutingModelRuntime, id: string, raw: ModelRoutingSdkModel[], diagnostics: ModelRoutingDiagnostic[]): Promise<ModelRoutingSdkModel | undefined> {
	const pair = parts(id); if (!pair) return undefined;
	const found = source.find ? await safe(() => source.find!(pair[0], pair[1]), diagnostics) : undefined; if (found) return found;
	try { return getModel(pair[0] as never, pair[1] as never) as unknown as ModelRoutingSdkModel; } catch { return raw.find((entry) => canonical(entry) === id); }
}
function emptyInspection(diagnostics: ModelRoutingDiagnostic[]): ModelRoutingInspection { return { contract: MODEL_ROUTING_CONTRACT, targets: {}, assignments: {}, agents: [], providers: [], models: [], diagnostics }; }

export async function inspectModelRouting(request: ModelRoutingRequest, dependencies: ModelRoutingDependencies = {}): Promise<ModelRoutingInspection> {
	const diagnostics: ModelRoutingDiagnostic[] = []; if (!supportedContract(request.contract)) diagnostics.push(diag("unsupported-contract", `Unsupported model-routing contract: ${String(request.contract)}.`, "error", "contract"));
	const context = contextOf(request, diagnostics); if (!context || diagnostics.length) return emptyInspection(diagnostics);
	let source: ModelRoutingModelRuntime; try { source = await runtime(context, request, dependencies, diagnostics); } catch { runtimeFailure(diagnostics); return emptyInspection(diagnostics); }
	await refresh(source, request, diagnostics);
	const [global, project] = await Promise.all([target(context, "global"), target(context, "project")]), selected = context.target === "global" ? global : project, discovery = dependencies.discoverAgents;
	let agents: ModelRoutingAgent[] = [];
	if (discovery) { try { agents = (await discovery(context.cwd, context.agentDir)).map((entry) => ({ ...entry, configurable: true as const, ...(selected.assignments[entry.name] ? { assignment: selected.assignments[entry.name] } : {}) })); } catch { diagnostics.push(diag("agent-discovery-failed", "Agent discovery failed during read-only inspection.", "error", "agents")); } }
	else diagnostics.push(diag("agent-discovery-not-provided", "Agent discovery is supplied by the host so the library does not duplicate Pi's discovery authority.", "warning"));
	const models = await catalog(source, diagnostics);
	return { contract: MODEL_ROUTING_CONTRACT, context, targets: { global, project }, assignments: selected.assignments, agents, providers: models.providers, models: models.models, diagnostics };
}
function draft(value: unknown): AgentModelConfig | undefined { if (!object(value)) return undefined; const normalized = normalizeModelConfig(value); return normalized && !Object.keys(value).some((key) => !(key in normalized)) ? normalized : undefined; }
export async function validateModelRouting(request: ModelRoutingValidationRequest, dependencies: ModelRoutingDependencies = {}): Promise<ModelRoutingValidationResult> {
	const diagnostics: ModelRoutingDiagnostic[] = []; if (!supportedContract(request.contract)) diagnostics.push(diag("unsupported-contract", `Unsupported model-routing contract: ${String(request.contract)}.`, "error", "contract"));
	const config = draft(request.draft); if (!config) diagnostics.push(diag("malformed-draft", "The draft must be a normalized agent assignment object.", "error", "draft"));
	const context = contextOf(request, diagnostics); if (diagnostics.length || !config || !context) return { contract: MODEL_ROUTING_CONTRACT, ok: false, diagnostics };
	let source: ModelRoutingModelRuntime; try { source = await runtime(context, request, dependencies, diagnostics); } catch { runtimeFailure(diagnostics); return { contract: MODEL_ROUTING_CONTRACT, ok: false, diagnostics }; }
	await refresh(source, request, diagnostics); const cataloged = await catalog(source, diagnostics), byId = new Map(cataloged.models.map((entry) => [entry.canonicalId, entry]));
	for (const [agent, entry] of Object.entries(config)) if (entry.model) {
		const id = normalizeModelId(entry.model), resolved = id ? await resolveModel(source, id, cataloged.raw, diagnostics) : undefined, model = id ? byId.get(id) : undefined;
		if (!id || !resolved || !model || !model.configured) diagnostics.push(diag("model-unavailable", `Model ${entry.model} is not cataloged or configured for authentication.`, "error", `${agent}.model`));
		if (entry.thinking && model?.supportedThinkingLevels && !model.supportedThinkingLevels.includes(entry.thinking)) diagnostics.push(diag("thinking-unsupported", `Thinking level ${entry.thinking} is not supported by ${entry.model}.`, "error", `${agent}.thinking`));
	}
	return { contract: MODEL_ROUTING_CONTRACT, ok: !diagnostics.some((entry) => entry.severity === "error"), diagnostics };
}
export const getModelRoutingCapabilities = capabilities;
export const inspect = inspectModelRouting;
export const validate = validateModelRouting;
