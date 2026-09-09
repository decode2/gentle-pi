import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const HOST_DEADLINE_MS = 5_500;
const PROBE_DEADLINE_MS = 7_000;
const CLEANUP_DEADLINE_MS = 900;
const hostScript = fileURLToPath(new URL("./host.ps1", import.meta.url));

const emit = (stage, status, details = {}) => process.stdout.write(`${JSON.stringify({ stage, status, details })}\n`);
const diagnostic = (message) => process.stderr.write(`${String(message).slice(0, 1_000)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function windowsPowerShell51Path() {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error("SystemRoot is not an absolute Windows path");
	return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

function parseJsonLine(line) {
	if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new Error("host emitted an oversized line");
	const value = JSON.parse(line);
	if (!value || typeof value !== "object" || typeof value.stage !== "string" || typeof value.status !== "string") throw new Error("host emitted an invalid record");
	return value;
}

function deadline(label, ms, signal) {
	let timer, abort;
	const promise = new Promise((_, reject) => {
		timer = setTimeout(() => reject(new Error(`deadline exceeded: ${label}`)), ms);
		abort = () => { clearTimeout(timer); reject(signal.reason ?? new Error(`cancelled: ${label}`)); };
		if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
	});
	return { promise, cancel: () => { clearTimeout(timer); signal.removeEventListener("abort", abort); } };
}

async function within(label, operation, ms, lifecycle) {
	const guard = deadline(label, ms, lifecycle.signal);
	try { return await Promise.race([operation, guard.promise]); }
	catch (error) { lifecycle.abort(error); throw error; }
	finally { guard.cancel(); }
}

function childExit(child) {
	if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
	return new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
}

async function terminateOwnedChild(child, limitMs = 650) {
	const exited = childExit(child);
	const wait = async (ms) => Promise.race([exited, sleep(ms).then(() => undefined)]);
	let result = await wait(Math.floor(limitMs / 3));
	if (result) return { ...result, forced: false, settled: true };
	try { child.kill("SIGTERM"); } catch {}
	result = await wait(Math.floor(limitMs / 3));
	if (result) return { ...result, forced: true, settled: true };
	try { child.kill("SIGKILL"); } catch {}
	result = await wait(Math.ceil(limitMs / 3));
	return result ? { ...result, forced: true, settled: true } : { settled: false, forced: true };
}

class Lifecycle {
	constructor() {
		this.controller = new AbortController();
		this.sockets = new Set();
		this.host = undefined;
	}
	get signal() { return this.controller.signal; }
	abort(reason) {
		if (this.signal.aborted) return;
		this.controller.abort(reason);
		for (const socket of this.sockets) { try { socket.destroy(); } catch {} }
		if (this.host?.child) { try { this.host.child.kill("SIGTERM"); } catch {} }
	}
	track(socket) {
		this.sockets.add(socket);
		socket.once("close", () => this.sockets.delete(socket));
		return socket;
	}
}

function startHost(config, lifecycle) {
	const child = spawn(windowsPowerShell51Path(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", hostScript], {
		shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
	});
	const records = [];
	let outputBytes = 0, partial = "", resolveReady, rejectReady;
	const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	const exited = childExit(child);
	const reject = (error) => { try { rejectReady(error); } catch {} };
	child.stdout.on("data", (chunk) => {
		outputBytes += chunk.length;
		if (outputBytes > MAX_OUTPUT_BYTES) { reject(new Error("host stdout exceeded bound")); lifecycle.abort(new Error("host stdout exceeded bound")); return; }
		partial += chunk.toString("utf8");
		for (;;) {
			const newline = partial.indexOf("\n");
			if (newline < 0) break;
			const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
			try {
				const record = parseJsonLine(line); records.push(record); emit(`host:${record.stage}`, record.status, record.details);
				if (record.stage === "pipe-host" && record.status === "ready") resolveReady(record);
			} catch (error) { reject(error); lifecycle.abort(error); }
		}
		if (Buffer.byteLength(partial) > MAX_LINE_BYTES) { reject(new Error("host stdout line exceeded bound")); lifecycle.abort(new Error("host stdout line exceeded bound")); }
	});
	child.stderr.on("data", (chunk) => diagnostic(`host stderr: ${chunk.toString("utf8").slice(0, 1_000)}`));
	child.once("error", reject);
	exited.then(() => reject(new Error("host exited before ready")));
	lifecycle.signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch {} }, { once: true });
	child.stdin.end(`${JSON.stringify(config)}\n`);
	const host = { child, records, ready, exited };
	lifecycle.host = host;
	return host;
}

function connectJsonl(path, request, lifecycle) {
	return new Promise((resolve, reject) => {
		const socket = lifecycle.track(createConnection({ path }));
		let partial = "", settled = false;
		const settle = (error, value) => {
			if (settled) return;
			settled = true; socket.destroy();
			if (error) reject(error); else resolve(value);
		};
		const timer = setTimeout(() => settle(new Error("named-pipe request timed out")), 2_000);
		const abort = () => complete(lifecycle.signal.reason ?? new Error("named-pipe request cancelled"));
		const complete = (error, value) => { clearTimeout(timer); lifecycle.signal.removeEventListener("abort", abort); settle(error, value); };
		lifecycle.signal.addEventListener("abort", abort, { once: true });
		socket.once("connect", () => { try { socket.write(`${JSON.stringify(request)}\n`); } catch (error) { complete(error); } });
		socket.on("data", (chunk) => {
			partial += chunk.toString("utf8");
			if (Buffer.byteLength(partial) > MAX_LINE_BYTES) return complete(new Error("named-pipe reply exceeded bound"));
			const newline = partial.indexOf("\n"); if (newline < 0) return;
			try {
				const reply = JSON.parse(partial.slice(0, newline));
				if (!reply || reply.ok !== true || reply.id !== request.id) throw new Error("named-pipe reply failed validation");
				complete(undefined, reply);
			} catch (error) { complete(error); }
		});
		socket.once("error", (error) => complete(error));
		socket.once("end", () => { if (!settled) complete(new Error("named-pipe closed before reply")); });
	});
}

function openHeldPartial(path, lifecycle) {
	return new Promise((resolve, reject) => {
		const socket = lifecycle.track(createConnection({ path }));
		const timer = setTimeout(() => { socket.destroy(); reject(new Error("held partial-frame connection timed out")); }, 1_500);
		const abort = () => { clearTimeout(timer); socket.destroy(); reject(lifecycle.signal.reason ?? new Error("held partial-frame cancelled")); };
		lifecycle.signal.addEventListener("abort", abort, { once: true });
		socket.once("connect", () => { clearTimeout(timer); lifecycle.signal.removeEventListener("abort", abort); socket.write('{"id":"held-frame","op":"ping"'); resolve(socket); });
		socket.once("error", (error) => { clearTimeout(timer); lifecycle.signal.removeEventListener("abort", abort); reject(error); });
	});
}

function classify(records, { pipeName, concurrent }) {
	if (records.some((record) => record.status === "blocked")) return "BLOCKED";
	const one = (stage, status, predicate = () => true) => {
		const matches = records.filter((record) => record.stage === stage);
		return matches.length === 1 && matches[0].status === status && predicate(matches[0].details);
	};
	const pipeEvents = records.filter((record) => record.stage === "pipe-host");
	const pipeTerminal = pipeEvents.length === 2 && pipeEvents[0].status === "ready" && pipeEvents[1].status === "observed" &&
		(!pipeName || (pipeEvents[0].details?.pipeName === pipeName && pipeEvents[1].details?.pipeName === pipeName)) &&
		pipeEvents[1].details?.acceptedConnections >= 2 && pipeEvents[1].details?.concurrentAcceptEvidence === true;
	const required = one("environment", "observed") &&
		one("token-elevation", "observed", (details) => details?.elevated === false) &&
		one("pipe-security-overload", "supported") &&
		one("metadata-directory", "observed", (details) => details?.protectedDacl === true && Array.isArray(details.allowSids) && details.allowSids.length === 1 && details.allowSids[0] === "current-account") &&
		one("native-capability", "supported") &&
		one("metadata-publication", "observed", (details) => details?.requiredMetadataCapability === true && details?.junctionProbe === "rejected_by_handle_attribute") &&
		pipeTerminal && concurrent;
	return required ? "PASS" : "UNSUPPORTED";
}

async function cleanup(lifecycle, tempRoot) {
	lifecycle.abort(new Error("probe lifecycle cleanup"));
	const child = lifecycle.host?.child;
	const childResult = child ? await terminateOwnedChild(child, Math.floor(CLEANUP_DEADLINE_MS / 2)) : { settled: true, forced: false };
	let rootRemoved = !tempRoot;
	if (tempRoot) {
		const deletion = rm(tempRoot, { recursive: true, force: true, maxRetries: 0 }).then(() => true, () => false);
		rootRemoved = await Promise.race([deletion, sleep(Math.floor(CLEANUP_DEADLINE_MS / 2)).then(() => false)]);
	}
	return { child: childResult, rootRemoved };
}

async function runProbe(lifecycle) {
	if (process.platform !== "win32") return { classification: "UNSUPPORTED", reason: "Windows-only CI feasibility probe", tempRoot: undefined };
	let tempRoot;
	try {
		tempRoot = await mkdtemp(join(tmpdir(), "gentle-pi-windows-transport-"));
		const pipeName = `gentle_pi_probe_${randomBytes(12).toString("hex")}`;
		const host = startHost({ pipeName, tempRoot, deadlineMs: HOST_DEADLINE_MS }, lifecycle);
		const ready = await within("host readiness", host.ready, 2_500, lifecycle);
		if (ready.details?.pipeName !== pipeName) throw new Error("host returned an unexpected pipe name");
		const held = await within("held partial connection", openHeldPartial(`\\\\.\\pipe\\${pipeName}`, lifecycle), 1_750, lifecycle);
		const reply = await within("independent request", connectJsonl(`\\\\.\\pipe\\${pipeName}`, { id: "independent-request", op: "ping", payload: "bounded" }, lifecycle), 2_250, lifecycle);
		emit("independent-process-request-reply", "observed", { reply, partialFrameHeldDuringReply: !held.destroyed });
		held.destroy();
		const exit = await within("host result", host.exited, 1_500, lifecycle);
		const result = host.records.filter((record) => record.stage === "pipe-host" && record.status !== "ready").at(-1);
		const concurrent = result?.details?.acceptedConnections >= 2 && result?.details?.concurrentAcceptEvidence === true;
		emit("concurrent-accept", concurrent ? "observed" : "unsupported", { hostResult: result?.details ?? null, exit });
		return { classification: classify(host.records, { pipeName, concurrent }), tempRoot, records: host.records };
	} catch (error) {
		const records = lifecycle.host?.records ?? [];
		let classification = classify(records, { pipeName: undefined, concurrent: false });
		if (!records.some((record) => record.stage === "pipe-host" && record.status === "ready") && records.length === 0) {
			emit("host-execution", "BLOCKED", { reason: "host did not reach a machine-readable stage; script execution refusal is not worked around" });
			classification = "BLOCKED";
		}
		if (classification === "PASS") classification = "UNSUPPORTED";
		return { classification, reason: String(error).slice(0, 240), tempRoot, records };
	}
}

async function selfTestDeadline() {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const started = Date.now();
	const result = await terminateOwnedChild(child, 300);
	const elapsedMs = Date.now() - started;
	const pass = result.settled === true && elapsedMs <= 450;
	emit("self-test-deadline", pass ? "PASS" : "UNSUPPORTED", { elapsedMs, child: result });
	return pass ? 0 : 1;
}

function selfTestClassification() {
	const pipeName = "classification-test-pipe";
	const records = [
		{ stage: "environment", status: "observed", details: {} },
		{ stage: "token-elevation", status: "observed", details: { elevated: false } },
		{ stage: "pipe-security-overload", status: "supported", details: {} },
		{ stage: "metadata-directory", status: "observed", details: { protectedDacl: true, allowSids: ["current-account"] } },
		{ stage: "native-capability", status: "supported", details: {} },
		{ stage: "metadata-publication", status: "observed", details: { requiredMetadataCapability: true, junctionProbe: "rejected_by_handle_attribute" } },
		{ stage: "pipe-host", status: "ready", details: { pipeName } },
		{ stage: "pipe-host", status: "observed", details: { pipeName, acceptedConnections: 2, concurrentAcceptEvidence: true } },
	];
	const cases = [
		["ready_then_observed", records, true, "PASS"],
		["ready_only", records.slice(0, -1), false, "UNSUPPORTED"],
		["blocked_cannot_be_overwritten", [...records, { stage: "token-elevation", status: "blocked", details: {} }, { stage: "token-elevation", status: "observed", details: { elevated: false } }], true, "BLOCKED"],
		["unsupported_cannot_be_overwritten", [...records, { stage: "native-capability", status: "unsupported", details: {} }, { stage: "native-capability", status: "supported", details: {} }], true, "UNSUPPORTED"],
		["missing_required_capability", records.filter((record) => record.stage !== "native-capability"), true, "UNSUPPORTED"],
		["terminal_pipe_session_mismatch", [...records.slice(0, -1), { stage: "pipe-host", status: "observed", details: { pipeName: "other", acceptedConnections: 2, concurrentAcceptEvidence: true } }], true, "UNSUPPORTED"],
	];
	const results = cases.map(([name, input, concurrent, expected]) => ({ name, expected, actual: classify(input, { pipeName, concurrent }) }));
	const pass = results.every((result) => result.actual === result.expected);
	emit("self-test-classification", pass ? "GREEN" : "RED", { results });
	return pass ? 0 : 1;
}

async function main() {
	if (process.argv.includes("--self-test-deadline")) return selfTestDeadline();
	if (process.argv.includes("--self-test-classification")) return selfTestClassification();
	const lifecycle = new Lifecycle();
	let hardExit = false;
	const runWatchdog = setTimeout(() => lifecycle.abort(new Error("run deadline exceeded")), PROBE_DEADLINE_MS);
	const totalWatchdog = setTimeout(() => {
		lifecycle.abort(new Error("total probe and cleanup deadline exceeded"));
		emit("watchdog", "UNSUPPORTED", { reason: "hard exit protects CI from a continuing owned operation; owned temporary root may remain" });
		setTimeout(() => process.exit(1), 50).unref();
	}, PROBE_DEADLINE_MS + CLEANUP_DEADLINE_MS + 250);
	const result = await runProbe(lifecycle);
	clearTimeout(runWatchdog);
	const cleanupResult = await cleanup(lifecycle, result.tempRoot);
	clearTimeout(totalWatchdog);
	const classification = cleanupResult.child.settled && cleanupResult.rootRemoved ? result.classification : "UNSUPPORTED";
	emit("final", classification, {
		reason: result.reason,
		cleanup: cleanupResult,
		limitations: { pipeDaclReadback: "unverified", ancestorReparseTOCTOU: "unverified", secondUserDenial: "unverified", fileIdentityStability: "unverified" },
		meaning: classification === "PASS" ? "experimental feasibility only; not product support" : "blocked or unsupported feasibility result",
	});
	if (!cleanupResult.child.settled || !cleanupResult.rootRemoved) {
		hardExit = true;
		emit("cleanup", "UNSUPPORTED", { reason: "cleanup deadline expired; owned temporary root may remain" });
		setTimeout(() => process.exit(1), 50).unref();
	}
	return hardExit ? 1 : classification === "PASS" ? 0 : 1;
}

const exitCode = await main().catch((error) => {
	emit("final", "UNSUPPORTED", { reason: String(error).slice(0, 240), meaning: "unhandled probe failure" });
	return 1;
});
process.exitCode = exitCode;
