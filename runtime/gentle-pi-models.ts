import { pathToFileURL } from "node:url";
const MODEL_ROUTING_CONTRACT = "gentle-pi.model-routing/v1" as const;
const MODEL_ROUTING_OPERATIONS = ["capabilities", "inspect", "validate", "apply"] as const;
const EXIT = { success: 0, invalidInput: 2, unsupported: 3, unavailable: 4, persistence: 5, partial: 6 } as const;
type Input = { version?: unknown; contract?: unknown; operation?: unknown; cwd?: unknown; agentDir?: unknown; target?: unknown; configHome?: unknown; draft?: unknown; loadExtensions?: unknown };
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const diagnostic = (code: string, message: string, path?: string) => ({ code, message, severity: "error" as const, ...(path ? { path } : {}) });
type RuntimeModules = {
	applyModelConfigAsync: (...args: any[]) => Promise<any>;
	listDiscoverableAgents: (...args: any[]) => any;
	applyModelRouting: (...args: any[]) => Promise<any>;
	inspectModelRouting: (...args: any[]) => Promise<any>;
	validateModelRouting: (...args: any[]) => Promise<any>;
};
function capabilities(request: { contract?: unknown } = {}) { return { contract: MODEL_ROUTING_CONTRACT, supported: request.contract === undefined || request.contract === MODEL_ROUTING_CONTRACT, operations: MODEL_ROUTING_OPERATIONS }; }
function dependencies(input: Input, modules: RuntimeModules) {
	const target = input.target as "global" | "project";
	return { discoverAgents: (cwd: string, agentDir: string) => modules.listDiscoverableAgents(cwd, agentDir, target), materialize: (_context: unknown, config: any, options: { dryRun: boolean }) => modules.applyModelConfigAsync(input.cwd as string, config, { target, agentDir: input.agentDir as string, dryRun: options.dryRun }) };
}
function request(input: Input) {
	return { contract: input.contract, cwd: input.cwd as string, agentDir: input.agentDir as string, target: input.target as "global" | "project", ...(typeof input.configHome === "string" ? { configHome: input.configHome } : {}), ...(input.loadExtensions === true ? { loadExtensions: true } : {}) };
}
function exitClass(operation: string, result: any): keyof typeof EXIT {
	if (operation === "apply") { if (result.outcome === "success") return "success"; if (result.outcome === "partial") return "partial"; if (result.outcome === "persistence-failure") return "persistence"; if (result.outcome === "unavailable-runtime") return "unavailable"; }
	const diagnostics = Array.isArray(result?.diagnostics) ? result.diagnostics : [];
	if (diagnostics.some((entry: any) => entry.code === "unsupported-contract")) return "unsupported";
	if (diagnostics.some((entry: any) => ["missing-cwd", "missing-agent-dir", "missing-target", "invalid-target", "malformed-draft"].includes(entry.code))) return "invalidInput";
	if (diagnostics.some((entry: any) => ["model-unavailable", "thinking-unsupported", "runtime-read-only-failure", "agent-discovery-failed"].includes(entry.code))) return "unavailable";
	return result?.ok === false ? "invalidInput" : "success";
}
function emit(operation: string, result: unknown, ok: boolean, exit: keyof typeof EXIT): never {
	const response = { version: 1, contract: MODEL_ROUTING_CONTRACT, operation, ok, exitClass: exit === "invalidInput" ? "invalid-input" : exit === "unsupported" ? "unsupported-contract" : exit === "unavailable" ? "unavailable-runtime" : exit, result };
	process.stdout.write(`${JSON.stringify(response)}\n`);
	if (!ok) process.stderr.write(`${JSON.stringify((result as any)?.diagnostics ?? [diagnostic("process-failure", "Model routing request failed.")])}\n`);
	process.exit(EXIT[exit]);
}
export async function run(input: unknown): Promise<never> {
	if (!record(input)) emit("unknown", { diagnostics: [diagnostic("invalid-json-request", "Request must be one JSON object.", "request")] }, false, "invalidInput");
	const value = input as Input;
	if (value.version !== 1 || !["capabilities", "inspect", "validate", "apply"].includes(value.operation as string)) emit(String(value.operation ?? "unknown"), { diagnostics: [diagnostic("unsupported-version-or-operation", "Request version and operation are unsupported.", "version")] }, false, "unsupported");
	if (value.operation !== "capabilities" && (typeof value.cwd !== "string" || !value.cwd || typeof value.agentDir !== "string" || !value.agentDir || (value.target !== "global" && value.target !== "project"))) emit(String(value.operation), { diagnostics: [diagnostic("invalid-request", "cwd, agentDir, and target are required explicitly.", "request")] }, false, "invalidInput");
	const operation = value.operation as "capabilities" | "inspect" | "validate" | "apply";
	try {
		if (operation === "capabilities") { const result = capabilities({ contract: value.contract }); emit(operation, result, result.supported, result.supported ? "success" : "unsupported"); }
		const [{ applyModelConfigAsync, listDiscoverableAgents }, { applyModelRouting, inspectModelRouting, validateModelRouting }] = await Promise.all([
			import("../extensions/gentle-ai.ts"),
			import("../lib/model-routing-contract.ts"),
		]);
		const base = request(value), deps = dependencies(value, { applyModelConfigAsync, listDiscoverableAgents, applyModelRouting, inspectModelRouting, validateModelRouting });
		if (operation === "inspect") { const result = await inspectModelRouting(base, deps); emit(operation, result, !result.diagnostics.some(({ severity }: { severity: string }) => severity === "error"), exitClass(operation, result)); }
		if (operation === "validate") { const result = await validateModelRouting({ ...base, draft: value.draft }, deps); emit(operation, result, result.ok, exitClass(operation, result)); }
		const result = await applyModelRouting({ ...base, draft: value.draft }, deps); emit(operation, result, result.ok, exitClass(operation, result));
	} catch (error) { emit(operation, { diagnostics: [diagnostic("unavailable-runtime", error instanceof Error ? error.message : String(error), "runtime")] }, false, "unavailable"); }
}
export function runStdin(): void {
	let source = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { source += chunk; });
	process.stdin.on("end", () => { try { void run(JSON.parse(source)); } catch (error) { emit("unknown", { diagnostics: [diagnostic("invalid-json-request", error instanceof Error ? error.message : String(error), "request")] }, false, "invalidInput"); } });
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) runStdin();
