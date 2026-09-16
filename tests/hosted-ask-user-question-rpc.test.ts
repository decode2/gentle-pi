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
const REFERENCE_ROOT = "/reference";
const TOOL_NAME = "ask_user_question";
const PROVIDER_ID = "hosted-questionnaire-synthetic";
const MODEL_ID = "hosted-questionnaire-model";
const QUESTION = "Which layout should we inspect?";
const CUSTOM_ANSWER = "  leading  internal\ntrailing  ";
const FINAL_TEXT = {
	cancel: "Synthetic provider completed after questionnaire cancellation.",
	single: "Synthetic provider completed after questionnaire single selection.",
	custom: "Synthetic provider completed after questionnaire custom response.",
} as const;
const CANCELLED_MARKER = "hosted:ask_user_question:cancelled";
const COMPLETED_MARKER = "hosted:ask_user_question:completed";
const ISOLATION_MARKER = "docker-network-none-readonly-v1";
const OWNED_EXTENSION_PATH = `${CHECKOUT_ROOT}/extensions/ask-user-question.ts`;
const REFERENCE_EXTENSION_PATH = `${REFERENCE_ROOT}/node_modules/@juicesharp/rpiv-ask-user-question/index.ts`;
const FIXTURE_PATH = `${CHECKOUT_ROOT}/tests/fixtures/hosted-synthetic-provider.ts`;
const PROMPT_PROJECTION_PREFIX = "hosted:rpiv:ask-user:prompt:projection:";
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
type HostedScenario = "cancel" | "single" | "custom";
type RunResult = { events: RpcRecord[]; cancellationResponses: number };
type HostedCase = { name: "owned" | "reference"; candidatePath: string; expectedSourcePath?: string; reference: boolean; scenario: HostedScenario };
type StableResult = { content: unknown; details: { cancelled: unknown; answers: unknown } };
type ComparableResult = { result: StableResult; promptProjection: RpcRecord; blocked: boolean[] };

type PiPackage = { name?: string; version?: string; bin?: string | Record<string, string> };

function record(value: unknown, label: string): RpcRecord { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label); return value as RpcRecord; }

function mountOptions(mountPoint: string): string[] { const line = readFileSync("/proc/self/mountinfo", "utf8").split("\n").find((candidate) => candidate.split(" - ")[0]?.split(" ")[4] === mountPoint); assert.ok(line, `missing mount readback for ${mountPoint}`); return line.split(" - ")[0]!.split(" ")[5]!.split(","); }

function assertHostedIsolation(reference: boolean): void {
	assert.match(process.version, /^v24\./); assert.equal(process.env.GENTLE_PI_HOSTED_ISOLATION, ISOLATION_MARKER); assert.equal(process.getuid?.(), 1000);
	assert.ok(mountOptions("/").includes("ro"), "root filesystem must be read-only"); assert.ok(mountOptions(CHECKOUT_ROOT).includes("ro"), "checkout mount must be read-only");
	if (reference) assert.ok(mountOptions(REFERENCE_ROOT).includes("ro"), "reference mount must be read-only");
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

function notificationMessages(events: RpcRecord[]): string[] {
	return events.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
		.map((event) => event.message).filter((message): message is string => typeof message === "string");
}

function assertPromptProjection(value: unknown): RpcRecord {
	const projection = record(value, "prompt projection");
	assert.deepEqual(Object.keys(projection).sort(), ["questions"]);
	assert.ok(Array.isArray(projection.questions));
	for (const rawQuestion of projection.questions as unknown[]) {
		const question = record(rawQuestion, "prompt projection question");
		assert.deepEqual(Object.keys(question).sort(), ["header", "multiSelect", "options", "question"]);
		assert.equal(typeof question.question, "string"); assert.equal(typeof question.header, "string"); assert.equal(typeof question.multiSelect, "boolean");
		assert.ok(Array.isArray(question.options));
		for (const rawOption of question.options as unknown[]) {
			const option = record(rawOption, "prompt projection option");
			assert.deepEqual(Object.keys(option).sort(), ["description", "hasPreview", "label"]);
			assert.equal(typeof option.label, "string"); assert.equal(typeof option.description, "string"); assert.equal(typeof option.hasPreview, "boolean");
		}
	}
	return projection;
}

function promptProjection(events: RpcRecord[]): RpcRecord {
	const messages = notificationMessages(events).filter((message) => message.startsWith(PROMPT_PROJECTION_PREFIX));
	assert.equal(messages.length, 1);
	return assertPromptProjection(JSON.parse(messages[0]!.slice(PROMPT_PROJECTION_PREFIX.length)));
}

function blockedSequence(events: RpcRecord[]): boolean[] {
	const sequence = notificationMessages(events).flatMap((message) => message === MARKERS[6] ? [true] : message === MARKERS[7] ? [false] : []);
	assert.deepEqual(sequence, [true, false]);
	return sequence;
}

function expectedAnswer(scenario: Exclude<HostedScenario, "cancel">): RpcRecord {
	return { questionIndex: 0, question: QUESTION, kind: scenario === "single" ? "option" : "custom", answer: scenario === "single" ? "Compact" : CUSTOM_ANSWER };
}

function successfulContent(answer: string): string {
	return `User has answered your questions: "${QUESTION}"="${answer}". You can now continue with the user's answers in mind.`;
}

function assertSuccessfulResult(content: unknown, details: RpcRecord, scenario: Exclude<HostedScenario, "cancel">): void {
	const expected = expectedAnswer(scenario);
	assert.equal(details.cancelled, false);
	assert.deepEqual(details.answers, [expected]);
	assert.deepEqual(content, [{ type: "text", text: successfulContent(expected.answer as string) }]);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), milliseconds);
		promise.then((value) => { clearTimeout(timer); resolvePromise(value); }, (error) => { clearTimeout(timer); rejectPromise(error); });
	});
}

async function runRpc(cliPath: string, candidatePath: string, fixturePath: string, sandbox: string, expectedSourcePath?: string, scenario: HostedScenario = "cancel"): Promise<RunResult> {
	assert.ok(candidatePath === OWNED_EXTENSION_PATH || candidatePath === REFERENCE_EXTENSION_PATH, `unsupported hosted questionnaire candidate: ${candidatePath}`);
	assert.equal(fixturePath, FIXTURE_PATH);
	assert.equal(expectedSourcePath, candidatePath === REFERENCE_EXTENSION_PATH ? REFERENCE_EXTENSION_PATH : undefined);
	const dirs = ["home", "profile", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "xdg-runtime", "tmp", "agent", "sessions", "cwd"];
	await Promise.all(dirs.map((name) => mkdir(join(sandbox, name), { recursive: true })));
	const ownerPath = join(sandbox, "agent", "gentle-ai", "question-owner.json");
	await mkdir(dirname(ownerPath), { recursive: true });
	await writeFile(ownerPath, `${JSON.stringify({ schema: "gentle-pi.question-owner/v1", owner: "gentle-pi" })}\n`);
	assert.deepEqual(JSON.parse(await readFile(ownerPath, "utf8")), { schema: "gentle-pi.question-owner/v1", owner: "gentle-pi" });
	const tempPath = (name: string) => join(sandbox, name);
	const childEnv: Record<string, string> = {
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		HOME: tempPath("home"), USERPROFILE: tempPath("profile"),
		XDG_CONFIG_HOME: tempPath("xdg-config"), XDG_CACHE_HOME: tempPath("xdg-cache"),
		XDG_DATA_HOME: tempPath("xdg-data"), XDG_STATE_HOME: tempPath("xdg-state"), XDG_RUNTIME_DIR: tempPath("xdg-runtime"),
		TMPDIR: tempPath("tmp"), TMP: tempPath("tmp"), TEMP: tempPath("tmp"),
		PI_CODING_AGENT_DIR: tempPath("agent"), PI_CODING_AGENT_SESSION_DIR: tempPath("sessions"),
		GENTLE_PI_AGENT_HOME: tempPath("agent"), GENTLE_PI_CONFIG_HOME: tempPath("xdg-config"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		GENTLE_PI_HOSTED_SCENARIO: scenario,
	};
	if (expectedSourcePath !== undefined) childEnv.GENTLE_PI_HOSTED_EXPECTED_SOURCE_PATH = expectedSourcePath;
	assert.deepEqual(Object.keys(childEnv).sort(), ["GENTLE_PI_AGENT_HOME", "GENTLE_PI_CONFIG_HOME", "GENTLE_PI_HOSTED_SCENARIO", "HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", ...(expectedSourcePath === undefined ? [] : ["GENTLE_PI_HOSTED_EXPECTED_SOURCE_PATH"])].sort());
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
	let dialogIndex = 0;
	const observedDialogMethods: string[] = [];
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
	const selectStep = (matcher: (option: string) => boolean, label: string) => (event: RpcRecord): void => {
		assert.equal(event.method, "select", `${label} must use select`);
		if (!Array.isArray(event.options)) throw new Error(`${label} must expose options`);
		const matches = event.options.filter((option): option is string => typeof option === "string" && matcher(option));
		assert.equal(matches.length, 1, `${label} must have one matching emitted option`);
		assert.equal(typeof event.id, "string", `${label} request must have an RPC id`);
		send({ type: "extension_ui_response", id: event.id, value: matches[0] });
	};
	const textStep = (methods: readonly ("editor" | "input")[], label: string) => (event: RpcRecord): void => {
		assert.ok(methods.includes(event.method as "editor" | "input"), `${label} used unexpected method ${String(event.method)}`);
		assert.equal(typeof event.id, "string", `${label} request must have an RPC id`);
		send({ type: "extension_ui_response", id: event.id, value: CUSTOM_ANSWER });
	};
	const cancelStep = (event: RpcRecord): void => {
		assert.equal(event.method, "select", "cancellation must start with select");
		if (cancellationResponses !== 0) throw new Error("hosted questionnaire requested more than one selection dialog");
		assert.equal(typeof event.id, "string", "selection request must have an RPC id");
		cancellationResponses += 1;
		send({ type: "extension_ui_response", id: event.id, cancelled: true });
	};
	const owned = candidatePath === OWNED_EXTENSION_PATH;
	const plannedDialogs: Array<(event: RpcRecord) => void> = scenario === "cancel" ? [cancelStep]
		: owned
			? scenario === "single"
				? [selectStep((option) => option === "Choose an option", "owned single action"), selectStep((option) => option === "Compact", "owned single option"), selectStep((option) => option === "Submit", "owned single submit")]
				: [selectStep((option) => option === "Use custom text", "owned custom action"), textStep(["editor", "input"], "owned custom text"), selectStep((option) => option === "Submit", "owned custom submit")]
			: scenario === "single"
				? [selectStep((option) => /^1\. Compact — .+$/.test(option), "reference single option")]
				: [selectStep((option) => option === "3. Type something.", "reference custom option"), textStep(["input"], "reference custom text")];
	const fireAndForget = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
	const onLine = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line) return;
		try {
			const event = record(JSON.parse(line), "RPC stdout must contain JSON objects");
			events.push(event);
			if (event.type === "extension_ui_request") {
				if (typeof event.method !== "string") throw new Error("extension UI request method must be a string");
				if (!fireAndForget.has(event.method)) {
					const step = plannedDialogs[dialogIndex];
					if (!step) throw new Error(`unexpected or extra extension dialog: ${event.method}`);
					observedDialogMethods.push(event.method);
					step(event);
					dialogIndex += 1;
				}
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
		assert.equal(dialogIndex, plannedDialogs.length, "planned hosted questionnaire dialog sequence was not fully consumed");
		assert.equal(observedDialogMethods.length, plannedDialogs.length, "hosted questionnaire dialog count changed");
		return { events, cancellationResponses };
	} finally {
		if (!exit) {
			child.kill("SIGTERM");
			try { exit = await withTimeout(exited, 2_000, `Pi child ${childPid} SIGTERM cleanup`); }
			catch { child.kill("SIGKILL"); await withTimeout(exited, 2_000, `Pi child ${childPid} SIGKILL cleanup`); }
		}
	}
}

test("hosted real Pi RPC compares owned and public reference", async (t) => {
	const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	assert.equal(repoRoot, CHECKOUT_ROOT);
	const candidatePath = join(repoRoot, "extensions", "ask-user-question.ts");
	const fixturePath = join(repoRoot, "tests", "fixtures", "hosted-synthetic-provider.ts");
	assert.equal(candidatePath, OWNED_EXTENSION_PATH);
	assert.equal(fixturePath, FIXTURE_PATH);
	await access(candidatePath, constants.R_OK);
	await access(fixturePath, constants.R_OK);
	await access(REFERENCE_EXTENSION_PATH, constants.R_OK);
	await assert.rejects(access(repoRoot, constants.W_OK));
	const cliPath = resolvePiCli(repoRoot);
	const cases: HostedCase[] = [
		{ name: "owned", candidatePath, reference: false, scenario: "cancel" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "cancel" },
		{ name: "owned", candidatePath, reference: false, scenario: "single" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "single" },
		{ name: "owned", candidatePath, reference: false, scenario: "custom" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "custom" },
	];
	const comparable = new Map<HostedScenario, ComparableResult[]>();
	for (const testCase of cases) {
		await t.test(`hosted ${testCase.name} ${testCase.scenario}`, async (caseTest) => {
			assertHostedIsolation(testCase.reference === true);
			const sandbox = await mkdtemp(join(tmpdir(), `gentle-pi-hosted-rpc-${testCase.name}-${testCase.scenario}-`));
			caseTest.after(async () => { await rm(sandbox, { recursive: true, force: true }); });
			const result = await runRpc(cliPath, testCase.candidatePath, fixturePath, sandbox, testCase.expectedSourcePath, testCase.scenario);
			const cancelled = testCase.scenario === "cancel";
			assert.equal(result.cancellationResponses, cancelled ? 1 : 0);
			for (const marker of MARKERS) assert.equal(notificationCount(result.events, marker), marker === CANCELLED_MARKER ? (cancelled ? 1 : 0) : 1, marker);
			assert.equal(notificationCount(result.events, COMPLETED_MARKER), cancelled ? 0 : 1, `${COMPLETED_MARKER}; ${notificationMessages(result.events).filter((message) => message.startsWith("hosted:questionnaire-result-rejected:")).slice(0, 4).map((message) => message.slice(0, 800)).join("\n").slice(0, 2000)}`);
			const dialogs = result.events.filter((event) => event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(String(event.method)));
			const dialogMethods = dialogs.map((event) => String(event.method));
			if (cancelled) assert.deepEqual(dialogMethods, ["select"]);
			else if (testCase.name === "owned" && testCase.scenario === "single") assert.deepEqual(dialogMethods, ["select", "select", "select"]);
			else if (testCase.name === "owned") { assert.equal(dialogMethods[0], "select"); assert.ok(dialogMethods[1] === "editor" || dialogMethods[1] === "input"); assert.equal(dialogMethods[2], "select"); }
			else if (testCase.scenario === "single") assert.deepEqual(dialogMethods, ["select"]);
			else assert.deepEqual(dialogMethods, ["select", "input"]);
			const selection = result.events.filter((event) => event.type === "extension_ui_request" && event.method === "select");
			assert.equal(selection.length, cancelled ? 1 : testCase.name === "owned" ? testCase.scenario === "single" ? 3 : 2 : 1);
			if (cancelled && testCase.name === "owned") {
				assert.match(String(selection[0]!.title), /Which layout should we inspect/);
				assert.deepEqual(selection[0]!.options, ["Choose an option", "Use custom text", "Skip", "Submit", "Submit partial", "Cancel"]);
			}
			const promptResponses = result.events.filter((event) => event.type === "response" && event.command === "prompt");
			assert.equal(promptResponses.length, 1);
			assert.equal(promptResponses[0]!.success, true);
			const toolEnds = result.events.filter((event) => event.type === "tool_execution_end" && event.toolName === TOOL_NAME);
			assert.equal(toolEnds.length, 1);
			const execution = record(toolEnds[0]!.result, "tool execution result");
			assert.equal(toolEnds[0]!.isError, false);
			const executionDetails = record(execution.details, "tool execution details");
			const messages = result.events.filter((event) => event.type === "message_end").map((event) => record(event.message, "message_end message"));
			const toolResult = messages.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
			assert.ok(toolResult);
			assert.equal(toolResult.isError, false);
			const toolResultDetails = record(toolResult.details, "tool result details");
			if (testCase.scenario === "cancel") {
				assert.equal(executionDetails.cancelled, true);
				assert.deepEqual(executionDetails.answers, []);
				assert.equal(toolResultDetails.cancelled, true);
				assert.deepEqual(toolResultDetails.answers, []);
			} else {
				assertSuccessfulResult(execution.content, executionDetails, testCase.scenario);
				assertSuccessfulResult(toolResult.content, toolResultDetails, testCase.scenario);
			}
			const assistants = messages.filter((message) => message.role === "assistant");
			assert.ok(assistants.length >= 2);
			const finalAssistant = assistants[assistants.length - 1]!;
			assert.equal(finalAssistant.stopReason, "stop");
			const content = Array.isArray(finalAssistant.content) ? finalAssistant.content : [];
			assert.ok(content.some((block) => record(block, "assistant content").text === FINAL_TEXT[testCase.scenario]));
			assert.equal(result.events.filter((event) => event.type === "agent_settled").length, 1);
			const scenarioResults = comparable.get(testCase.scenario) ?? [];
			scenarioResults.push({ result: { content: execution.content, details: { cancelled: executionDetails.cancelled, answers: executionDetails.answers } }, promptProjection: promptProjection(result.events), blocked: blockedSequence(result.events) });
			comparable.set(testCase.scenario, scenarioResults);
		});
	}
	for (const scenario of ["cancel", "single", "custom"] as const) {
		const pair = comparable.get(scenario) ?? [];
		assert.equal(pair.length, 2, `${scenario} must have owned and reference results`);
		assert.deepEqual(pair[1]!.result, pair[0]!.result, scenario === "cancel" ? "public cancellation result parity" : `public ${scenario} result parity`);
		assert.deepEqual(pair[1]!.promptProjection, pair[0]!.promptProjection, `${scenario} JSON-safe prompt projection parity`);
		assert.deepEqual(pair[1]!.blocked, pair[0]!.blocked, `${scenario} blocked-event sequence parity`);
	}
});
