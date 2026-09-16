import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CHECKOUT_ROOT = "/workspace";
const TOOL_NAME = "ask_user_question";
const PROVIDER_ID = "hosted-questionnaire-synthetic";
const MODEL_ID = "hosted-questionnaire-model";
const FINAL_TEXT = "Synthetic provider completed after questionnaire cancellation.";
const ISOLATION_MARKER = "docker-network-none-readonly-v1";
const MARKERS = [
	"hosted:session_start",
	"hosted:before_agent_start",
	"hosted:ask_user_question:registered",
	"hosted:ask_user_question:invoked",
	"hosted:ask_user_question:cancelled",
	"hosted:rpiv:ask-user:prompt",
	"hosted:rpiv:ask-user:blocked:true",
	"hosted:rpiv:ask-user:blocked:false",
];

type RpcRecord = Record<string, unknown>;
type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };
type RunResult = { events: RpcRecord[]; cancellationResponses: number };

type PiPackage = { name?: string; version?: string; bin?: string | Record<string, string> };

function record(value: unknown, label: string): RpcRecord { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label); return value as RpcRecord; }

function mountOptions(mountPoint: string): string[] { const line = readFileSync("/proc/self/mountinfo", "utf8").split("\n").find((candidate) => candidate.split(" - ")[0]?.split(" ")[4] === mountPoint); assert.ok(line, `missing mount readback for ${mountPoint}`); return line.split(" - ")[0]!.split(" ")[5]!.split(","); }

function assertHostedIsolation(): void {
	assert.match(process.version, /^v24\./); assert.equal(process.env.GENTLE_PI_HOSTED_ISOLATION, ISOLATION_MARKER); assert.equal(process.getuid?.(), 1000);
	assert.ok(mountOptions("/").includes("ro"), "root filesystem must be read-only"); assert.ok(mountOptions(CHECKOUT_ROOT).includes("ro"), "checkout mount must be read-only");
	const status = readFileSync("/proc/self/status", "utf8"); assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^CapEff:\s+0+$/m);
	assert.deepEqual(Object.keys(networkInterfaces()).filter((name) => name !== "lo"), []);
}

function resolvePiCli(repoRoot: string): string {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), packageRoot = dirname(dirname(entry));
	const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PiPackage;
	assert.equal(metadata.name, "@earendil-works/pi-coding-agent"); assert.equal(metadata.version, "0.85.1");
	const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi;
	if (typeof bin !== "string") throw new Error("Pi package has no public pi bin");
	assert.equal(bin, "dist/bundle/cli.js"); const cliPath = resolve(packageRoot, bin);
	assert.ok(relative(repoRoot, cliPath).startsWith("node_modules")); return cliPath;
}

function notificationCount(events: RpcRecord[], message: string): number {
	return events.filter((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message === message).length;
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), milliseconds);
		promise.then((value) => { clearTimeout(timer); resolvePromise(value); }, (error) => { clearTimeout(timer); rejectPromise(error); });
	});
}

async function runRpc(cliPath: string, candidatePath: string, fixturePath: string, sandbox: string): Promise<RunResult> {
	const dirs = ["home", "profile", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "xdg-runtime", "tmp", "agent", "sessions", "cwd"];
	await Promise.all(dirs.map((name) => mkdir(join(sandbox, name), { recursive: true })));
	const ownerPath = join(sandbox, "agent", "gentle-ai", "question-owner.json");
	await mkdir(dirname(ownerPath), { recursive: true });
	await writeFile(ownerPath, `${JSON.stringify({ schema: "gentle-pi.question-owner/v1", owner: "gentle-pi" })}\n`);
	assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), { schema: "gentle-pi.question-owner/v1", owner: "gentle-pi" });
	const tempPath = (name: string) => join(sandbox, name);
	const childEnv = {
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		HOME: tempPath("home"), USERPROFILE: tempPath("profile"),
		XDG_CONFIG_HOME: tempPath("xdg-config"), XDG_CACHE_HOME: tempPath("xdg-cache"),
		XDG_DATA_HOME: tempPath("xdg-data"), XDG_STATE_HOME: tempPath("xdg-state"), XDG_RUNTIME_DIR: tempPath("xdg-runtime"),
		TMPDIR: tempPath("tmp"), TMP: tempPath("tmp"), TEMP: tempPath("tmp"),
		PI_CODING_AGENT_DIR: tempPath("agent"), PI_CODING_AGENT_SESSION_DIR: tempPath("sessions"),
		GENTLE_PI_AGENT_HOME: tempPath("agent"), GENTLE_PI_CONFIG_HOME: tempPath("xdg-config"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
	};
	assert.deepEqual(Object.keys(childEnv).sort(), ["GENTLE_PI_AGENT_HOME", "GENTLE_PI_CONFIG_HOME", "HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME"].sort());
	for (const path of Object.values(childEnv).filter((value) => value.startsWith("/"))) {
		assert.ok(relative(CHECKOUT_ROOT, path).startsWith(".."), `child path must be outside checkout: ${path}`);
	}

	const args = [cliPath, "--mode", "rpc", "--no-session", "--no-extensions", "-e", candidatePath, "-e", fixturePath, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--no-approve", "--offline", "--model", `${PROVIDER_ID}/${MODEL_ID}`];
	const child = spawn(process.execPath, args, { cwd: tempPath("cwd"), env: childEnv, stdio: ["pipe", "pipe", "pipe"], shell: false });
	const childPid = child.pid;
	assert.ok(childPid, "hosted Pi child PID must be tracked");
	const events: RpcRecord[] = [];
	let stderr = "";
	let buffer = "";
	let cancellationResponses = 0;
	let completionClaimed = false;
	let resolveCompletion!: () => void;
	let rejectCompletion!: (error: unknown) => void;
	const completion = new Promise<void>((resolvePromise, rejectPromise) => { resolveCompletion = resolvePromise; rejectCompletion = rejectPromise; });
	const exited = new Promise<ExitStatus>((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
	const fail = (error: unknown): void => { if (!completionClaimed) { completionClaimed = true; rejectCompletion(error); } };
	child.once("exit", (code, signal) => {
		if (!completionClaimed) fail(new Error(`Pi child exited before settling (${signal ?? code}); stderr: ${stderr}`));
	});
	const send = (command: RpcRecord): void => {
		if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("hosted Pi stdin is not writable");
		child.stdin.write(`${JSON.stringify(command)}\n`);
	};
	const onLine = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line) return;
		try {
			const event = record(JSON.parse(line), "RPC stdout must contain JSON objects");
			events.push(event);
			if (event.type === "extension_ui_request" && event.method === "select") {
				if (cancellationResponses !== 0) throw new Error("hosted questionnaire requested more than one selection dialog");
				if (typeof event.id !== "string") throw new Error("selection request must have an RPC id");
				cancellationResponses += 1;
				send({ type: "extension_ui_response", id: event.id, cancelled: true });
			}
			if (event.type === "agent_settled") { completionClaimed = true; resolveCompletion(); }
		} catch (error) { fail(error); }
	};
	const decoder = new StringDecoder("utf8");
	child.stdout?.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0) { onLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); }
	});
	child.stdout?.on("end", () => { buffer += decoder.end(); if (buffer) onLine(buffer); });
	child.stdout?.on("error", fail);
	child.stderr?.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${chunk}`.slice(-4000); });
	child.stderr?.on("error", fail);
	child.stdin?.on("error", fail);
	child.once("error", fail);
	let exit: ExitStatus | undefined;
	try {
		send({ id: "hosted-prompt-1", type: "prompt", message: "Use ask_user_question to choose a layout; do not answer until the questionnaire is complete." });
		await withTimeout(completion, 30_000, `Pi child ${childPid} completion`);
		child.stdin?.end();
		exit = await withTimeout(exited, 5_000, `Pi child ${childPid} exit`);
		assert.equal(exit.code, 0, `Pi child exited with ${exit.signal ?? exit.code}; stderr: ${stderr}`);
		return { events, cancellationResponses };
	} finally {
		if (!exit) {
			child.kill("SIGTERM");
			try { exit = await withTimeout(exited, 2_000, `Pi child ${childPid} SIGTERM cleanup`); }
			catch { child.kill("SIGKILL"); await withTimeout(exited, 2_000, `Pi child ${childPid} SIGKILL cleanup`); }
		}
	}
}

test("hosted real Pi cancels ask_user_question through RPC and continues", async (t) => {
	assertHostedIsolation();
	const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	assert.equal(repoRoot, CHECKOUT_ROOT);
	const candidatePath = join(repoRoot, "extensions", "ask-user-question.ts");
	const fixturePath = join(repoRoot, "tests", "fixtures", "hosted-synthetic-provider.ts");
	await access(candidatePath, constants.R_OK);
	await access(fixturePath, constants.R_OK);
	await assert.rejects(access(repoRoot, constants.W_OK));
	const cliPath = resolvePiCli(repoRoot);
	const sandbox = await mkdtemp(join(tmpdir(), "gentle-pi-hosted-rpc-"));
	t.after(async () => { await rm(sandbox, { recursive: true, force: true }); });
	const result = await runRpc(cliPath, candidatePath, fixturePath, sandbox);
	assert.equal(result.cancellationResponses, 1);
	for (const marker of MARKERS) assert.equal(notificationCount(result.events, marker), 1, marker);
	const selection = result.events.filter((event) => event.type === "extension_ui_request" && event.method === "select");
	assert.equal(selection.length, 1);
	assert.match(String(selection[0]!.title), /Which layout should we inspect/);
	assert.deepEqual(selection[0]!.options, ["Choose an option", "Use custom text", "Skip", "Submit", "Submit partial", "Cancel"]);
	const promptResponses = result.events.filter((event) => event.type === "response" && event.command === "prompt");
	assert.equal(promptResponses.length, 1);
	assert.equal(promptResponses[0]!.success, true);
	const toolEnds = result.events.filter((event) => event.type === "tool_execution_end" && event.toolName === TOOL_NAME);
	assert.equal(toolEnds.length, 1);
	const execution = record(toolEnds[0]!.result, "tool execution result");
	assert.equal(toolEnds[0]!.isError, false);
	assert.equal(record(execution.details, "tool execution details").cancelled, true);
	assert.deepEqual(record(execution.details, "tool execution details").answers, []);
	const messages = result.events.filter((event) => event.type === "message_end").map((event) => record(event.message, "message_end message"));
	const toolResult = messages.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
	assert.ok(toolResult);
	assert.equal(toolResult.isError, false);
	assert.equal(record(toolResult.details, "tool result details").cancelled, true);
	const assistants = messages.filter((message) => message.role === "assistant");
	assert.ok(assistants.length >= 2);
	const finalAssistant = assistants[assistants.length - 1]!;
	assert.equal(finalAssistant.stopReason, "stop");
	const content = Array.isArray(finalAssistant.content) ? finalAssistant.content : [];
	assert.ok(content.some((block) => record(block, "assistant content").text === FINAL_TEXT));
	assert.equal(result.events.filter((event) => event.type === "agent_settled").length, 1);
});
