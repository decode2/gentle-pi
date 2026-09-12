import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { spawn as nodeSpawn } from "node:child_process";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { AgentRunner } from "../lib/agents-runner.ts";
import { AGENT_MODE } from "../lib/agents-config.ts";
import { TaskStore, TASK_STATUS } from "../lib/agents-protocol.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CHILD = fileURLToPath(new URL("./fixtures/agents-compaction-timeout-child.mjs", import.meta.url));
const NODE = process.env.PROBE_NODE ?? process.execPath;
const OUTER_NET = process.env.PROBE_OUTER_NET;
const EXPECTED_SOURCE_SHA = process.env.EXPECTED_SOURCE_SHA;
function sourceSha() {
  const dotGit = join(ROOT, ".git");
  let gitDir = dotGit;
  try {
    const marker = readFileSync(dotGit, "utf8").trim();
    if (marker.startsWith("gitdir: ")) gitDir = isAbsolute(marker.slice(8)) ? marker.slice(8) : resolve(ROOT, marker.slice(8));
  } catch { /* A normal checkout has a .git directory. */ }
  const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
  return head.startsWith("ref: ") ? readFileSync(join(gitDir, head.slice(5)), "utf8").trim() : head;
}
let ACTUAL_SOURCE_SHA;
let SOURCE_ERROR;
try { ACTUAL_SOURCE_SHA = sourceSha(); if (!EXPECTED_SOURCE_SHA || EXPECTED_SOURCE_SHA !== ACTUAL_SOURCE_SHA) SOURCE_ERROR = "checkout source identity mismatch"; } catch { SOURCE_ERROR = "checkout source identity unavailable"; }
const NODE_SHA256 = createHash("sha256").update(readFileSync(NODE)).digest("hex");
const VIRTUAL_TIMEOUT = 240000;
const TOTAL_DEADLINE_MS = 15000;
const MAX_BYTES = 128 * 1024;
const MAX_MESSAGES = 256;
let activeFailure;
function fail(error) { if (!activeFailure) activeFailure = error instanceof Error ? error : new Error(String(error)); }
function namespace() { try { return readlinkSync("/proc/self/ns/net"); } catch { return undefined; } }
function safeEnv(caseName, ownedRoot) {
  return { PATH: "/usr/bin:/bin", HOME: join(ownedRoot, "home"), TMPDIR: join(ownedRoot, "tmp"), XDG_CONFIG_HOME: join(ownedRoot, "config"), XDG_CACHE_HOME: join(ownedRoot, "cache"), XDG_DATA_HOME: join(ownedRoot, "data"), PI_OFFLINE: "1", PI_TELEMETRY: "0", PROBE_ROOT: ownedRoot, PROBE_CASE: caseName, PROBE_OUTER_NET: OUTER_NET ?? "", EXPECTED_SOURCE_SHA: EXPECTED_SOURCE_SHA ?? "" };
}
function boundedLines(stream, observe) {
  let bytes = 0;
  let buffer = "";
  stream.on("data", (chunk) => {
    try {
      bytes += Buffer.byteLength(String(chunk));
      if (bytes > MAX_BYTES) throw new Error("stdout bound exceeded");
      buffer += String(chunk);
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) return;
        const line = buffer.slice(0, end).replace(/\r$/, "");
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        try { observe(JSON.parse(line)); } catch { throw new Error("unparseable RPC output"); }
      }
    } catch (error) { fail(error); }
  });
}
function makeRequest(caseName, ownedRoot) {
  return { agent: { name: "compaction-timeout-probe", description: "", filePath: CHILD, scope: "project", instructions: "", model: { provider: `probe-${caseName}`, id: "characterization-model" }, thinking: "off", mode: AGENT_MODE.TASK, tools: [] }, prompt: `Characterization prompt ${"x".repeat(1024)}`, label: `hosted Linux ${caseName}`, context: undefined, mode: AGENT_MODE.TASK, cwd: ownedRoot, parentSessionId: `probe-parent-${caseName}`, model: { provider: `probe-${caseName}`, id: "characterization-model" }, thinking: "off", sessionDir: join(ownedRoot, "sessions"), resumeSessionPath: undefined, env: safeEnv(caseName, ownedRoot) };
}
class VirtualScheduler {
  nowValue = 0;
  jobs = [];
  now() { return this.nowValue; }
  schedule(fn, ms) { const job = { at: this.nowValue + ms, fn, cancelled: false }; this.jobs.push(job); return () => { job.cancelled = true; }; }
  advance(ms) { this.nowValue += ms; for (;;) { const ready = this.jobs.filter((job) => !job.cancelled && job.at <= this.nowValue); this.jobs = this.jobs.filter((job) => job.cancelled || job.at > this.nowValue); if (!ready.length) return; for (const job of ready) { try { job.fn(); } catch (error) { fail(error); } } } }
}
async function boundedWait(value, label, deadlineAt) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (fn, result) => { clearTimeout(timer); fn(result); };
    const finishSuccess = (result) => {
      if (activeFailure) return finish(reject, activeFailure);
      if (Date.now() >= deadlineAt) return finish(reject, new Error(`deadline waiting for ${label}`));
      return finish(resolve, result);
    };
    const poll = () => { if (activeFailure) return finish(reject, activeFailure); if (Date.now() >= deadlineAt) return finish(reject, new Error(`deadline waiting for ${label}`)); timer = setTimeout(poll, 20); };
    Promise.resolve(value).then(finishSuccess, (error) => finish(reject, error));
    poll();
  });
}
async function waitUntil(predicate, label, deadlineAt) {
  const end = deadlineAt;
  while (Date.now() < end) { if (activeFailure) throw activeFailure; if (predicate()) return; await sleep(20); }
  throw new Error(`deadline waiting for ${label}`);
}
function observeFrame(state, frame) {
  state.messages += 1;
  if (state.messages > MAX_MESSAGES) throw new Error("RPC message bound exceeded");
  if (frame.type === "response" && frame.command === "get_state" && frame.success === true) state.getState = true;
  if (frame.type === "response" && frame.command === "prompt" && frame.success === true) state.prompt = true;
  if (frame.type === "compaction_start" && frame.reason === "threshold") { state.compaction = true; state.compactionStarts += 1; }
  if (frame.type === "compaction_end") state.compactionEnds += 1;
  if (frame.type === "message_update") { state.rpcUpdates += 1; if (state.compaction) state.rpcUpdatesAfterCompaction += 1; if (state.rpcUpdates <= 3) state.initialEvents.push(frame.assistantMessageEvent?.type); }
  if (state.timedOut) state.lateFrames += 1;
  if (frame.type === "response" && frame.success === false) throw new Error(`RPC ${String(frame.command)} rejected`);
}
async function waitForCleanup(child, group, closed, deadlineAt) {
  while (Date.now() < deadlineAt) {
    if (!closed.value) { await sleep(20); continue; }
    if (!group) throw new Error("owned process group was not created");
    try { process.kill(-group, 0); } catch (error) { if (error.code === "ESRCH") return; throw error; }
    await sleep(20);
  }
  throw new Error("deadline waiting for physical child close and process group disappearance");
}
async function cleanup(child, group, closed, ownedRoot, evidence) {
  let cleanupError;
  let cleanupObserved = false;
  const remember = (error) => { cleanupError ??= error instanceof Error ? error : new Error(String(error)); };
  const wait = async (deadlineAt) => { try { await waitForCleanup(child, group, closed, deadlineAt); cleanupObserved = true; } catch (error) { remember(error); } };
  if (child && !closed.value) {
    try { child.kill("SIGTERM"); } catch (error) { remember(error); }
    await wait(Date.now() + 3000);
  }
  if (child && !closed.value) {
    try { child.kill("SIGKILL"); } catch (error) { remember(error); }
    await wait(Date.now() + 1000);
  }
  if (child && !closed.value) remember(new Error("physical child close unconfirmed"));
  if (child && closed.value) {
    try { await waitForCleanup(child, group, closed, Date.now() + 1000); cleanupObserved = true; }
    catch (error) { remember(error); }
  }
  evidence.physicalCloseObserved = Boolean(child && closed.value);
  evidence.processGroupGone = evidence.physicalCloseObserved && cleanupObserved;
  try { rmSync(ownedRoot, { recursive: true, force: true }); } catch (error) { remember(error); }
  evidence.cleanupError = cleanupError?.message;
  return cleanupError;
}










let currentCaseEvidence;
async function runCase(caseName) {
  const caseEvidence = { case: caseName, physicalCloseObserved: false, processGroupGone: false, cleanupError: undefined };
  currentCaseEvidence = caseEvidence;
  const startedAt = Date.now();
      const deadlineAt = startedAt + TOTAL_DEADLINE_MS;
  const ownedRoot = mkdtempSync(join(tmpdir(), "agents-compaction-timeout-"));
  for (const name of ["home", "tmp", "config", "cache", "data", "sessions"]) mkdirSync(join(ownedRoot, name), { recursive: true });
  const scheduler = new VirtualScheduler();
  const store = new TaskStore();
  const state = { messages: 0, bytes: 0, getState: false, prompt: false, compaction: false, compactionStarts: 0, compactionEnds: 0, rpcUpdates: 0, rpcUpdatesAfterCompaction: 0, initialEvents: [], lateFrames: 0, receipt: undefined, timedOut: false };
  let child;
  let group;
  let task;
  const closed = { value: false, promise: undefined, resolve: undefined };
  closed.promise = new Promise((resolve) => { closed.resolve = resolve; });
  let result;
  try {
    const spawn = (command, args, options) => {
      assert.equal(command, NODE);
      assert.equal(args[2], CHILD);
      assert.equal(args.includes("--experimental-import-meta-resolve"), true);
      assert.equal(args.includes("--experimental-strip-types"), true);
      assert.equal(args.includes("--mode") && args[args.indexOf("--mode") + 1] === "rpc", true);
      child = nodeSpawn(command, args, options);
      group = child.pid;
      boundedLines(child.stdout, (frame) => { try { observeFrame(state, frame); } catch (error) { fail(error); } });
      child.stderr?.on("data", (chunk) => { state.bytes += Buffer.byteLength(String(chunk)); if (state.bytes > MAX_BYTES) fail(new Error("stderr bound exceeded")); });
      child.on("message", (value) => { try { state.bytes += Buffer.byteLength(JSON.stringify(value)); if (++state.messages > MAX_MESSAGES || state.bytes > MAX_BYTES) throw new Error("IPC bound exceeded"); if (value && typeof value === "object" && value.probeReceipt) state.receipt = value.probeReceipt; } catch (error) { fail(error); } });
      child.on("close", () => { closed.value = true; closed.resolve(); });
      return child;
    };
    const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: VIRTUAL_TIMEOUT }, { spawn, now: () => scheduler.now(), schedule: (fn, ms) => scheduler.schedule(fn, ms), pi: { command: NODE, args: ["--experimental-import-meta-resolve", "--experimental-strip-types", CHILD] }, process: { platform: "linux", kill: (pid, signal) => process.kill(pid, signal) } }, { askUser: async () => ({ cancelled: true }) });
    task = runner.run(makeRequest(caseName, ownedRoot));
    await waitUntil(() => state.getState, "get_state barrier", deadlineAt);
    await waitUntil(() => state.prompt, "prompt barrier", deadlineAt);
    await waitUntil(() => state.compaction, "threshold compaction_start", deadlineAt);
    await waitUntil(() => state.receipt !== undefined, "private held receipt", deadlineAt);
    assert.equal(state.compactionStarts, 1);
    assert.equal(state.compactionEnds, 0);
    assert.equal(state.rpcUpdatesAfterCompaction, 0);
    assert.deepEqual(state.initialEvents, ["text_start", "text_delta", "text_end"]);
    assert.deepEqual(Object.keys(state.receipt).sort(), ["calls", "case", "category", "networkNamespace", "outerNetworkNamespace", "providerDeltas", "sdkVersion"]);
    assert.equal(state.receipt.category, "summary-held");
    assert.equal(state.receipt.case, caseName);
    assert.equal(state.receipt.calls, 2);
    assert.equal(state.receipt.sdkVersion, "0.85.1");
    assert.equal(state.receipt.networkNamespace && state.receipt.networkNamespace !== state.receipt.outerNetworkNamespace, true);
    assert.equal(state.receipt.providerDeltas, caseName === "finite-deltas" ? 2 : 0);
    scheduler.advance(VIRTUAL_TIMEOUT - 1);
    assert.equal(store.get(task.id)?.status, TASK_STATUS.RUNNING);
    state.timedOut = true;
    scheduler.advance(1);
    scheduler.advance(250);
    await boundedWait(closed.promise, "physical child close", deadlineAt);
    scheduler.advance(25);
    const finished = await boundedWait(runner.waitFor(task.id), "runner cleanup", deadlineAt);
    assert.equal(finished.status, TASK_STATUS.TIMED_OUT);
    assert.equal(finished.result, "initial response");
    assert.equal(finished.error, "stalled for 4 min");
    assert.equal(state.lateFrames, 0);
    assert.equal(state.compactionEnds, 0);
    assert.equal(state.receipt.providerDeltas, caseName === "finite-deltas" ? 2 : 0);
    result = { case: caseName, status: finished.status, virtualTimeoutMs: VIRTUAL_TIMEOUT, actualElapsedMs: Date.now() - startedAt, physicalCloseObserved: closed.value, processGroupGone: false, sdkVersion: state.receipt.sdkVersion, nodeSha256: NODE_SHA256, networkNamespace: state.receipt.networkNamespace, outerNetworkNamespace: state.receipt.outerNetworkNamespace, sdkSummaryRpcUpdates: state.rpcUpdatesAfterCompaction, providerDeltaCount: state.receipt.providerDeltas };
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    const cleanupError = await cleanup(child, group, closed, ownedRoot, caseEvidence);
    if (cleanupError && !activeFailure) throw cleanupError;
  }
  if (activeFailure) throw activeFailure;
  result.physicalCloseObserved = caseEvidence.physicalCloseObserved;
  result.processGroupGone = caseEvidence.processGroupGone;
  return result;
}
function categoryFor(error) {
  const text = String(error).toLowerCase();
  if (text.includes("cannot find module") || text.includes("package") || text.includes("dependency")) return "dependency/package";
  if (text.includes("sdk") || text.includes("identity") || text.includes("summary input")) return "SDK/fixture-contract";
  if (text.includes("cleanup") || text.includes("process group") || text.includes("close")) return "cleanup";
  if (text.includes("namespace") || text.includes("offline") || text.includes("isolated") || text.includes("node")) return "infrastructure/isolation";
  return "behavior";
}
async function main() {
  const results = [];
  let currentCase;
  try {
    if (SOURCE_ERROR) throw new Error(SOURCE_ERROR);
    if (namespace() === undefined || !OUTER_NET) throw new Error("outer network namespace provenance missing");
    for (const caseName of ["silent", "finite-deltas"]) { currentCase = caseName; results.push(await runCase(caseName)); }
    return { status: "success", category: "behavior", sdkVersion: "0.85.1", sourceSha: ACTUAL_SOURCE_SHA, nodeSha256: NODE_SHA256, cases: results, mechanics: "virtual default 240000ms; not actual elapsed 240000ms and not a production timeout recommendation" };
  } catch (error) {
    return { status: "failure", category: categoryFor(activeFailure ?? error), error: String(activeFailure ?? error).slice(0, 400), sdkVersion: "unobserved", sourceSha: ACTUAL_SOURCE_SHA ?? "unavailable", nodeSha256: NODE_SHA256, failedCase: currentCaseEvidence?.case ?? currentCase, physicalCloseObserved: currentCaseEvidence?.physicalCloseObserved ?? false, processGroupGone: currentCaseEvidence?.processGroupGone ?? false, cleanupError: currentCaseEvidence?.cleanupError, cases: results };
  }
}
const receipt = await main();
process.stdout.write(`${JSON.stringify(receipt)}\n`);
if (receipt.status !== "success") process.exitCode = 1;
