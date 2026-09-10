import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const SCHEMA = "gentle-pi.windows-native-boundary/v1";
const SUCCESS_STAGES = ["abi", "anchored-open", "dacl", "identity", "replace-delete", "reparse-negative"];
const FAILURE_STAGES = new Set([...SUCCESS_STAGES, "cleanup"]);
const MAX_BYTES = 16_384;
const POWERSHELL = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";

export function parseFixtureLine(line) {
	if (typeof line !== "string" || Buffer.byteLength(line, "utf8") > MAX_BYTES) throw new Error("malformed native-boundary result");
	let value;
	try { value = JSON.parse(line); } catch { throw new Error("malformed native-boundary result"); }
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed native-boundary result");
	const allowed = new Set(["schema", "ok", "stage", "architecture", "elevated", "stages", "scope"]);
	if (Object.keys(value).some((key) => !allowed.has(key)) || value.schema !== SCHEMA || typeof value.ok !== "boolean" || typeof value.architecture !== "string" || !["x86", "x64", "arm64"].includes(value.architecture) || typeof value.elevated !== "boolean") throw new Error("malformed native-boundary result");
	if (!value.ok) {
		if (typeof value.stage !== "string" || !FAILURE_STAGES.has(value.stage)) throw new Error("malformed native-boundary result");
		return Object.freeze({ schema: SCHEMA, ok: false, stage: value.stage, architecture: value.architecture, elevated: value.elevated });
	}
	if (!Array.isArray(value.stages) || value.stages.length !== SUCCESS_STAGES.length || value.stages.some((stage, index) => stage !== SUCCESS_STAGES[index]) || value.scope !== "private-disposable-root") throw new Error("malformed native-boundary result");
	return Object.freeze({ schema: SCHEMA, ok: true, stage: "complete", architecture: value.architecture, elevated: value.elevated, stages: Object.freeze([...value.stages]), scope: value.scope });
}

// command/args/spawnProcess are test seams. Real invocation is fixed PS5.1 -File.
export function runNativeBoundaryFixture({ script, timeoutMs = 15_000, command = POWERSHELL, args, spawnProcess = spawn } = {}) {
	if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) return Promise.reject(new Error("unavailable native-boundary host"));
	if (command === POWERSHELL && (process.platform !== "win32" || typeof script !== "string" || !existsSync(script))) return Promise.reject(new Error("unavailable native-boundary host"));
	const childArgs = args ?? ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script];
	return new Promise((resolve, reject) => {
		let child;
		try { child = spawnProcess(command, childArgs, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); } catch { reject(new Error("unavailable native-boundary host")); return; }
		let stdout = Buffer.alloc(0), abortError, settled = false;
		const settle = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(watchdog); clearTimeout(killWatchdog);
			if (error) reject(error); else resolve(result);
		};
		const abort = (error) => {
			if (abortError) return;
			abortError = error;
			child.stdout.destroy(); child.stderr.destroy();
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
			killWatchdog = setTimeout(() => settle(abortError), 1_000);
		};
		const watchdog = setTimeout(() => abort(new Error("timeout native-boundary host")), timeoutMs);
		let killWatchdog;
		child.once("error", () => abort(new Error("unavailable native-boundary host")));
		child.stdout.on("data", (chunk) => {
			stdout = Buffer.concat([stdout, chunk]);
			if (stdout.length > MAX_BYTES) abort(new Error("malformed native-boundary result"));
		});
		child.stdout.once("error", () => abort(new Error("malformed native-boundary result")));
		child.stderr.resume();
		child.once("close", (code, signal) => {
			if (abortError) { settle(abortError); return; }
			let result;
			try { result = parseFixtureLine(stdout.toString("utf8")); } catch (error) { settle(error); return; }
			const category = signal !== null ? "signal" : code !== 0 ? "nonzero-exit" : !result.ok ? "host-failure" : undefined;
			if (category) { settle(new Error(`native-boundary host failed (category: ${category}) (stage: ${result.stage})`)); return; }
			settle(undefined, result);
		});
	});
}
