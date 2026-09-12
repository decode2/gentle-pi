import { readFileSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ModelRuntime, SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, runRpcMode } from "@earendil-works/pi-coding-agent";

const sdkEntryUrl = await import.meta.resolve("@earendil-works/pi-coding-agent");
const sdkEntryPath = fileURLToPath(sdkEntryUrl);
const sdkManifest = JSON.parse(readFileSync(join(dirname(dirname(sdkEntryPath)), "package.json"), "utf8"));
const piAiUrl = await import.meta.resolve("@earendil-works/pi-ai", sdkEntryUrl);
const { InMemoryCredentialStore, createAssistantMessageEventStream } = await import(piAiUrl);
const sdkVersion = sdkManifest.version;
const expectedSdk = "0.85.1";
const CASE = process.env.PROBE_CASE === "finite-deltas" ? "finite-deltas" : "silent";
const providerId = `probe-${CASE}`;
const modelId = "characterization-model";
const apiId = "probe-api";
let calls = 0;
let measuredProviderDeltas = 0;
let summaryHeld = false;

function fail(message) { throw new Error(message); }
function namespace() { try { return readlinkSync("/proc/self/ns/net"); } catch { return undefined; } }
function assertEnvironment() {
  if (sdkVersion !== expectedSdk) fail(`SDK version mismatch: ${sdkVersion}`);
  if (process.env.PI_OFFLINE !== "1" || process.env.PI_TELEMETRY !== "0") fail("offline controls missing");
  const current = namespace();
  if (!current || !process.env.PROBE_OUTER_NET || current === process.env.PROBE_OUTER_NET) fail("network namespace provenance unavailable or unchanged");
  for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "PROBE_ROOT"]) if (!process.env[key]) fail(`missing isolated environment: ${key}`);
}
const usage = (input, output) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
function message(text, stopReason, input, output) { return { role: "assistant", content: [{ type: "text", text }], api: apiId, provider: providerId, model: modelId, usage: usage(input, output), stopReason, timestamp: Date.now() }; }
function streamSimple(model, context) {
  if (model.provider !== providerId || model.id !== modelId || model.api !== apiId) fail("synthetic identity mismatch before stream construction");
  const stream = createAssistantMessageEventStream();
  const serialized = JSON.stringify(context.messages);
  const isSummary = context.systemPrompt?.includes("summarize") || serialized.includes("<conversation>");
  calls += 1;
  if (isSummary) {
    if (calls !== 2 || summaryHeld || !serialized.includes("OLDER_MARKER")) fail("summary input or call sequence invalid");
    summaryHeld = true;
    stream.push({ type: "start", partial: message("", "pending", 0, 0) });
    if (CASE === "finite-deltas") {
      stream.push({ type: "text_start", contentIndex: 0, partial: message("", "pending", 0, 0) });
      measuredProviderDeltas += 1;
      stream.push({ type: "text_delta", contentIndex: 0, delta: "held", partial: message("held", "pending", 0, 1) });
      measuredProviderDeltas += 1;
      stream.push({ type: "text_delta", contentIndex: 0, delta: " summary", partial: message("held summary", "pending", 0, 2) });
    }
    process.send?.({ probeReceipt: { category: "summary-held", case: CASE, calls, providerDeltas: measuredProviderDeltas, sdkVersion, networkNamespace: namespace(), outerNetworkNamespace: process.env.PROBE_OUTER_NET } }, () => {});
    return stream;
  }
  if (calls !== 1) fail(`unexpected initial call: ${calls}`);
  const text = "initial response";
  const result = message(text, "stop", 3200, 8);
  stream.push({ type: "start", partial: result });
  stream.push({ type: "text_start", contentIndex: 0, partial: result });
  stream.push({ type: "text_delta", contentIndex: 0, delta: text, partial: result });
  stream.push({ type: "text_end", contentIndex: 0, content: text, partial: result });
  stream.push({ type: "done", reason: "stop", message: result });
  return stream;
}
function seed(cwd) {
  const entries = [{ type: "session", version: 3, id: `probe-${CASE}`, timestamp: new Date().toISOString(), cwd }];
  let parentId = null;
  for (let index = 0; index < 6; index += 1) {
    const userId = `old-user-${index}`;
    entries.push({ type: "message", id: userId, parentId, timestamp: new Date().toISOString(), message: { role: "user", content: `OLDER_MARKER_${index} ${"history ".repeat(100)}`, timestamp: Date.now() } });
    parentId = userId;
    const assistantId = `old-assistant-${index}`;
    entries.push({ type: "message", id: assistantId, parentId, timestamp: new Date().toISOString(), message: message("older answer", "stop", 120, 80) });
    parentId = assistantId;
  }
  return entries;
}
async function main() {
  assertEnvironment();
  const root = process.env.PROBE_ROOT;
  const agentDir = process.env.HOME;
  if (!root || !agentDir) fail("isolated roots missing");
  const credentials = new InMemoryCredentialStore();
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
  modelRuntime.registerProvider(providerId, { name: "Hosted Linux characterization provider", baseUrl: "https://probe.invalid", api: apiId, apiKey: "synthetic-auth-sentinel", models: [{ id: modelId, name: modelId, api: apiId, baseUrl: "https://probe.invalid", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 4096, maxTokens: 1024 }], streamSimple });
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 128 }, retry: { enabled: false } });
  const cwd = root;
  const createRuntime = async ({ cwd: targetCwd, sessionManager }) => {
    const services = await createAgentSessionServices({ cwd: targetCwd, agentDir, modelRuntime, settingsManager, resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true } });
    const model = modelRuntime.getModel(providerId, modelId);
    if (!model || model.provider !== providerId || model.id !== modelId || model.api !== apiId) fail("registered model identity mismatch");
    const created = await createAgentSessionFromServices({ services, sessionManager, model, thinkingLevel: "off", noTools: "all" });
    return { ...created, services, diagnostics: services.diagnostics };
  };
  const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd, undefined, seed(cwd)) });
  if (runtime.diagnostics.length || runtime.services.resourceLoader.getExtensions().extensions.length || runtime.services.resourceLoader.getSkills().skills.length || runtime.services.resourceLoader.getPrompts().prompts.length || runtime.services.resourceLoader.getThemes().themes.length || runtime.services.resourceLoader.getAgentsFiles().agentsFiles.length) fail("resource isolation was not empty");
  await runRpcMode(runtime);
}
main().catch((error) => { process.stderr.write(`probe child failure: ${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
