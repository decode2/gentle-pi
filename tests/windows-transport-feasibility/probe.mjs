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
const HOST_READY_DEADLINE_MS = 5_000;
const PROBE_DEADLINE_MS = 12_000;
const CLEANUP_DEADLINE_MS = 900;
const STDERR_LIMIT_BYTES = 4 * 1024;
const STARTUP_CONTROL_DEADLINE_MS = 30_000;
const hostScript = fileURLToPath(new URL("./host.ps1", import.meta.url));
const startupScript = fileURLToPath(new URL("./startup.ps1", import.meta.url));

let testOutputSink;
const emit = (stage, status, details = {}) => {
	const line = JSON.stringify({ stage, status, details });
	if (testOutputSink) testOutputSink.push(line); else process.stdout.write(`${line}\n`);
};
const diagnostic = (message) => process.stderr.write(`${String(message).slice(0, 1_000)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function windowsPowerShell51Path() {
	const systemRoot = process.env.SystemRoot;
	if (!systemRoot || !win32.isAbsolute(systemRoot)) throw new Error("SystemRoot is not an absolute Windows path");
	return win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

const windowsPowerShellFileArgs = (script) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script];

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

function safeCode(value, fallback) {
	return typeof value === "string" && /^[A-Z0-9_-]{1,48}$/.test(value) ? value : fallback;
}

function safeHostDetails(value, depth = 0) {
	if (depth > 3) return "omitted";
	if (value === null || typeof value === "boolean" || typeof value === "number") return value;
	if (typeof value === "string") return value.length > 256 || /[\\/]|[A-Za-z]:/.test(value) ? "redacted" : value;
	if (Array.isArray(value)) return value.slice(0, 16).map((entry) => safeHostDetails(entry, depth + 1));
	if (!value || typeof value !== "object") return "omitted";
	const safe = {};
	for (const [key, entry] of Object.entries(value).slice(0, 32)) {
		if (/^(message|path|username|token|secret|password)$/i.test(key)) { safe[key] = "redacted"; continue; }
		safe[key] = key === "error" ? safeCode(entry, "host-error") : safeHostDetails(entry, depth + 1);
	}
	return safe;
}

function appendStderr(state, chunk) {
	state.stderrBytes += chunk.length;
	const retained = Buffer.concat([state.stderrTail, chunk]);
	state.stderrTruncated ||= retained.length > STDERR_LIMIT_BYTES;
	state.stderrTail = retained.subarray(Math.max(0, retained.length - STDERR_LIMIT_BYTES));
}

function processDiagnostic(host) {
	const state = host.state, exit = state.exit ?? {};
	return {
		spawned: state.spawned,
		spawnError: state.spawnError,
		exitCode: Number.isInteger(exit.code) ? exit.code : null,
		signal: safeCode(exit.signal, null),
		recordCount: host.records.length,
		pendingStdoutBytes: host.pendingStdoutBytes(),
		stdinError: state.stdinError,
		stderrBytes: state.stderrBytes,
		stderrTruncated: state.stderrTruncated,
		stderrCategory: state.stderrBytes === 0 ? "empty" : "nonempty-retained-without-raw-output",
	};
}

function isServerReady(record) {
	return record.stage === "pipe-host" && record.status === "ready";
}

function emitConcurrentAccept(result, concurrent) {
	const terminalStatus = ["observed", "unsupported", "blocked"].includes(result?.status) ? result.status : "missing";
	emit("concurrent-accept", concurrent ? "observed" : "unsupported", { concurrent, terminalStatus, terminalCategory: result ? "host-terminal-record" : "missing" });
}

function startHost(config, lifecycle) {
	const child = spawn(windowsPowerShell51Path(), windowsPowerShellFileArgs(hostScript), {
		shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
	});
	const records = [], state = { spawned: false, spawnError: null, stdinError: null, exit: null, stderrBytes: 0, stderrTail: Buffer.alloc(0), stderrTruncated: false };
	let outputBytes = 0, partial = "", resolveReady, rejectReady;
	const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
	const exited = childExit(child);
	const reject = (error) => { try { rejectReady(error); } catch {} };
	child.once("spawn", () => { state.spawned = true; });
	child.stdout.on("data", (chunk) => {
		outputBytes += chunk.length;
		if (outputBytes > MAX_OUTPUT_BYTES) { reject(new Error("host stdout exceeded bound")); lifecycle.abort(new Error("host stdout exceeded bound")); return; }
		partial += chunk.toString("utf8");
		for (;;) {
			const newline = partial.indexOf("\n"); if (newline < 0) break;
			const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
			try {
				const record = parseJsonLine(line); records.push(record); emit(`host:${record.stage}`, record.status, safeHostDetails(record.details));
				if (isServerReady(record)) resolveReady(record);
			} catch (error) { reject(error); lifecycle.abort(error); }
		}
		if (Buffer.byteLength(partial) > MAX_LINE_BYTES) { reject(new Error("host stdout line exceeded bound")); lifecycle.abort(new Error("host stdout line exceeded bound")); }
	});
	child.stderr.on("data", (chunk) => appendStderr(state, chunk));
	child.stdin.once("error", (error) => { state.stdinError = safeCode(error.code, "stdin-error"); });
	child.once("error", (error) => { state.spawnError = safeCode(error.code, "spawn-error"); reject(error); });
	exited.then((exit) => { state.exit = exit; reject(new Error("host exited before server readiness")); });
	lifecycle.signal.addEventListener("abort", () => { try { child.kill("SIGTERM"); } catch {} }, { once: true });
	child.stdin.end(`${JSON.stringify(config)}\n`);
	const host = { child, records, ready, exited, state, pendingStdoutBytes: () => Buffer.byteLength(partial) };
	lifecycle.host = host;
	return host;
}

function launchStaticControl(executable, args) {
	const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
	const records = [], state = { spawned: false, spawnError: null, stdinError: null, exit: null, stderrBytes: 0, stderrTail: Buffer.alloc(0), stderrTruncated: false, stdoutBytes: 0, pendingStdoutBytes: 0, stdoutExceeded: false };
	let partial = "";
	const exited = childExit(child);
	child.once("spawn", () => { state.spawned = true; });
	child.stdout.on("data", (chunk) => {
		state.stdoutBytes += chunk.length;
		if (state.stdoutBytes > MAX_OUTPUT_BYTES) { state.stdoutExceeded = true; try { child.kill("SIGTERM"); } catch {} return; }
		partial += chunk.toString("utf8");
		for (;;) {
			const newline = partial.indexOf("\n"); if (newline < 0) break;
			const line = partial.slice(0, newline); partial = partial.slice(newline + 1);
			try { records.push(parseJsonLine(line)); } catch { state.stdoutExceeded = true; try { child.kill("SIGTERM"); } catch {} }
		}
		state.pendingStdoutBytes = Buffer.byteLength(partial);
		if (state.pendingStdoutBytes > MAX_LINE_BYTES) { state.stdoutExceeded = true; try { child.kill("SIGTERM"); } catch {} }
	});
	child.stderr.on("data", (chunk) => appendStderr(state, chunk));
	child.stdin.once("error", (error) => { state.stdinError = safeCode(error.code, "stdin-error"); });
	child.once("error", (error) => { state.spawnError = safeCode(error.code, "spawn-error"); });
	exited.then((exit) => { state.exit = exit; });
	child.stdin.end();
	return { child, records, state, exited };
}

function startupMarker(record) {
	const details = record?.details;
	return record?.stage === "startup-control" && record?.status === "observed" && details?.protocol === "ascii-jsonl-v1" &&
		typeof details.powershellVersion === "string" && /^[0-9.]+$/.test(details.powershellVersion) &&
		typeof details.dotNetVersion === "string" && /^[0-9.]+$/.test(details.dotNetVersion) && Number.isInteger(details.elapsedMs) && details.elapsedMs >= 0;
}

function destroyOwnedStdio(child) {
	for (const stream of [child.stdin, child.stdout, child.stderr]) { try { stream?.destroy(); } catch {} }
}

async function observeStaticControl(launched, deadlineMs) {
	const started = Date.now();
	let exit = await Promise.race([launched.exited, sleep(deadlineMs).then(() => undefined)]), timedOut = !exit;
	if (timedOut) { exit = await terminateOwnedChild(launched.child, 750); destroyOwnedStdio(launched.child); }
	else exit = { ...exit, settled: true, forced: false };
	const marker = launched.records.find(startupMarker);
	return {
		success: !timedOut && !launched.state.stdoutExceeded && exit.settled === true && exit.code === 0 && Boolean(marker),
		timedOut,
		childSettled: exit.settled === true,
		elapsedMs: Date.now() - started,
		exitCode: Number.isInteger(exit.code) ? exit.code : null,
		signal: safeCode(exit.signal, null),
		stdoutBytes: launched.state.stdoutBytes,
		stderrBytes: launched.state.stderrBytes,
		pendingStdoutBytes: launched.state.pendingStdoutBytes,
		recordCount: launched.records.length,
		spawned: launched.state.spawned,
		spawnError: launched.state.spawnError,
		stdinError: launched.state.stdinError,
		stderrTruncated: launched.state.stderrTruncated,
		marker: marker ? safeHostDetails(marker.details) : null,
	};
}

function forceExitSoon() {
	setTimeout(() => process.exit(1), 25).unref();
}

function finishStartupControl(result) {
	const clean = result.childSettled === true;
	emit("startup-control", result.success && clean ? "observed" : "unsupported", { ...result, cleanup: clean ? "owned-child-settled" : "owned-child-unsettled; force exit scheduled", meaning: "launcher control only; not product or transport feasibility" });
	if (!clean) forceExitSoon();
	return result.success && clean ? 0 : 1;
}

async function runStartupControl() {
	if (process.platform !== "win32") {
		emit("startup-control", "unsupported", { reason: "Windows-only startup control" });
		return 1;
	}
	let launched;
	const watchdog = setTimeout(() => {
		if (launched) { try { launched.child.kill("SIGTERM"); } catch {}; destroyOwnedStdio(launched.child); }
		emit("startup-control", "unsupported", { reason: "startup-control-total-deadline", cleanup: "owned-child-unsettled; force exit scheduled" });
		forceExitSoon();
	}, STARTUP_CONTROL_DEADLINE_MS + 850);
	try {
		launched = launchStaticControl(windowsPowerShell51Path(), windowsPowerShellFileArgs(startupScript));
		const result = await observeStaticControl(launched, STARTUP_CONTROL_DEADLINE_MS);
		clearTimeout(watchdog);
		return finishStartupControl(result);
	} catch (error) {
		clearTimeout(watchdog);
		if (launched) destroyOwnedStdio(launched.child);
		emit("startup-control", "unsupported", { reason: safeCode(error?.code, "startup-control-failure"), cleanup: launched ? "owned-child-unsettled; no cleanup claim" : "no-child" });
		return 1;
	}
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
		const ready = await within("host readiness", host.ready, HOST_READY_DEADLINE_MS, lifecycle);
		if (ready.details?.pipeName !== pipeName) throw new Error("host returned an unexpected pipe name");
		const held = await within("held partial connection", openHeldPartial(`\\\\.\\pipe\\${pipeName}`, lifecycle), 1_750, lifecycle);
		const reply = await within("independent request", connectJsonl(`\\\\.\\pipe\\${pipeName}`, { id: "independent-request", op: "ping", payload: "bounded" }, lifecycle), 2_250, lifecycle);
		emit("independent-process-request-reply", "observed", { reply, partialFrameHeldDuringReply: !held.destroyed });
		held.destroy();
		const exit = await within("host result", host.exited, 1_500, lifecycle);
		const result = host.records.filter((record) => record.stage === "pipe-host" && record.status !== "ready").at(-1);
		const concurrent = result?.details?.acceptedConnections >= 2 && result?.details?.concurrentAcceptEvidence === true;
		emitConcurrentAccept(result, concurrent);
		return { classification: classify(host.records, { pipeName, concurrent }), tempRoot, records: host.records };
	} catch (error) {
		const records = lifecycle.host?.records ?? [];
		let classification = classify(records, { pipeName: undefined, concurrent: false });
		if (classification === "PASS") classification = "UNSUPPORTED";
		return { classification, reason: safeCode(error?.code, "host-readiness-or-transport-failure"), tempRoot, records };
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

function selfTestDiagnostics() {
	const state = { spawned: true, spawnError: null, stdinError: "EPIPE", exit: { code: 23, signal: null }, stderrBytes: 0, stderrTail: Buffer.alloc(0), stderrTruncated: false };
	appendStderr(state, Buffer.alloc(STDERR_LIMIT_BYTES + 17, 120));
	const host = { state, records: [{ stage: "host-startup", status: "observed", details: { protocol: "ascii-jsonl-v1" } }], pendingStdoutBytes: () => 7 };
	const details = processDiagnostic(host);
	const cases = [
		["early_startup_is_not_server_ready", isServerReady(host.records[0]) === false],
		["zero_stage_is_neutral_unsupported", classify([], { pipeName: "test", concurrent: false }) === "UNSUPPORTED"],
		["explicit_capability_blocked_wins", classify([{ stage: "token-elevation", status: "blocked", details: {} }], { pipeName: "test", concurrent: false }) === "BLOCKED"],
		["stderr_is_bounded_without_raw_tail", details.stderrBytes === STDERR_LIMIT_BYTES + 17 && details.stderrTruncated === true && state.stderrTail.length === STDERR_LIMIT_BYTES && details.stderrCategory === "nonempty-retained-without-raw-output"],
		["exit_code_is_retained", details.exitCode === 23 && details.stdinError === "EPIPE"],
		["timing_covers_sequential_budget", HOST_READY_DEADLINE_MS === 5_000 && PROBE_DEADLINE_MS >= HOST_READY_DEADLINE_MS + HOST_DEADLINE_MS + 1_500],
	];
	const pass = cases.every(([, result]) => result);
	emit("self-test-diagnostics", pass ? "GREEN" : "RED", { cases: cases.map(([name, result]) => ({ name, result })) });
	return pass ? 0 : 1;
}

async function selfTestLauncher() {
	const marker = JSON.stringify({ stage: "startup-control", status: "observed", details: { protocol: "ascii-jsonl-v1", powershellVersion: "5.1", dotNetVersion: "4.8", elapsedMs: 0 } });
	const successful = await observeStaticControl(launchStaticControl(process.execPath, ["-e", `process.stdout.write(${JSON.stringify(`${marker}\n`)})`]), 500);
	const noOutput = await observeStaticControl(launchStaticControl(process.execPath, ["-e", "process.exit(0)" ]), 500);
	const deadlineResult = await observeStaticControl(launchStaticControl(process.execPath, ["-e", "setInterval(() => {}, 1000)" ]), 150);
	const cases = [
		["launcher_success_marker", successful.success === true && successful.exitCode === 0 && successful.stdoutBytes > 0],
		["launcher_no_output_is_unsupported", noOutput.success === false && noOutput.exitCode === 0 && noOutput.recordCount === 0],
		["launcher_deadline_kills_owned_child", deadlineResult.success === false && deadlineResult.timedOut === true && deadlineResult.exitCode === null && deadlineResult.signal !== null],
	];
	const pass = cases.every(([, result]) => result);
	emit("self-test-launcher", pass ? "GREEN" : "RED", { cases: cases.map(([name, result]) => ({ name, result })) });
	return pass ? 0 : 1;
}

async function selfTestStartupUnsettledChild() {
	setInterval(() => {}, 1_000);
	return finishStartupControl({ success: false, childSettled: false, timedOut: true, elapsedMs: 0, exitCode: null, signal: null, stdoutBytes: 0, stderrBytes: 0, pendingStdoutBytes: 0, recordCount: 0, spawned: true, spawnError: null, stdinError: null, stderrTruncated: false, marker: null });
}

async function selfTestStartupUnsettled() {
	const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--self-test-startup-unsettled-child"], { stdio: ["ignore", "pipe", "pipe"] });
	const started = Date.now();
	const exit = await Promise.race([childExit(child), sleep(250).then(() => undefined)]);
	const hung = !exit;
	if (hung) await terminateOwnedChild(child, 300);
	const pass = !hung && exit.code === 1 && Date.now() - started <= 400;
	emit("self-test-startup-unsettled", pass ? "GREEN" : "RED", { hung, exitCode: exit?.code ?? null, elapsedMs: Date.now() - started });
	return pass ? 0 : 1;
}

function selfTestPrivacy() {
	const sentinel = "PRIVATE_PATH_SENTINEL";
	const privateMessage = `C:\\${sentinel}\\token_${sentinel}_/home/${sentinel}`;
	const captured = [];
	testOutputSink = captured;
	try { emitConcurrentAccept({ status: "observed", details: { message: privateMessage } }, true); }
	finally { testOutputSink = undefined; }
	const record = JSON.parse(captured[0]);
	const noSentinel = !captured[0].includes(sentinel);
	const normalObserved = record.stage === "concurrent-accept" && record.status === "observed" && record.details.concurrent === true && record.details.terminalStatus === "observed" && record.details.terminalCategory === "host-terminal-record";
	emit("self-test-privacy", noSentinel && normalObserved ? "GREEN" : "RED", { noSentinel, normalObserved });
	return noSentinel && normalObserved ? 0 : 1;
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
	if (process.argv.includes("--self-test-startup-unsettled-child")) return selfTestStartupUnsettledChild();
	if (process.argv.includes("--self-test-startup-unsettled")) return selfTestStartupUnsettled();
	if (process.argv.includes("--startup-control")) return runStartupControl();
	if (process.argv.includes("--self-test-launcher")) return selfTestLauncher();
	if (process.argv.includes("--self-test-deadline")) return selfTestDeadline();
	if (process.argv.includes("--self-test-diagnostics")) return selfTestDiagnostics();
	if (process.argv.includes("--self-test-privacy")) return selfTestPrivacy();
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
	if (lifecycle.host) emit("process-diagnostic", "observed", processDiagnostic(lifecycle.host));
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
	emit("final", "UNSUPPORTED", { reason: safeCode(error?.code, "probe-internal-failure"), meaning: "unhandled probe failure" });
	return 1;
});
process.exitCode = exitCode;
