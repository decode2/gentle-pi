import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import nodeTest from "node:test";
import { ActiveSessionClient, ActiveSessionClientError, ActiveSessionListener, SessionPresenceError, type ReceivedNotification } from "../lib/agents-session-transport.ts";
import { WindowsNodeSessionPresenceRegistry, windowsNodePipeName, windowsNodeTransportPaths } from "../lib/windows-node-session-transport.ts";

const test = process.platform === "win32" ? nodeTest : nodeTest.skip;
const workerMode = process.env.GENTLE_NODE_WORKER === "1";
const controlLimit = 16_384;
const workerLine = (value: Record<string, unknown>) => `${JSON.stringify(value)}\n`;

async function runWorker() {
	const agentHome = process.env.GENTLE_AGENT_HOME, sessionId = process.env.GENTLE_NODE_SESSION;
	if (!agentHome || !sessionId) throw new Error("worker environment is incomplete");
	const registry = await WindowsNodeSessionPresenceRegistry.create(agentHome);
	const listener = new ActiveSessionListener(registry, sessionId, async (notification) => {
		await new Promise<void>((resolve, reject) => process.stdout.write(workerLine({ type: "callback", ...notification }), (error) => error ? reject(error) : resolve()));
	});
	const client = new ActiveSessionClient(registry, sessionId);
	await listener.start();
	const write = (value: Record<string, unknown>) => new Promise<void>((resolve, reject) => process.stdout.write(workerLine(value), (error) => error ? reject(error) : resolve()));
	await write({ type: "ready", sessionId });
	let input = Buffer.alloc(0), queue = Promise.resolve();
	const handle = async (line: Buffer) => {
		const command = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as { requestId: string; operation: string; recipientSessionId?: string; id?: string; message?: string };
		try {
			let result: unknown;
			if (command.operation === "send" && command.recipientSessionId && command.id && typeof command.message === "string") result = await client.sendNotification(command.recipientSessionId, command.message, { id: command.id });
			else if (command.operation === "stop") { client.close(); await listener.close(); result = { stopped: true }; }
			else throw new Error("invalid worker command");
			await write({ type: "reply", requestId: command.requestId, ok: true, result });
			if (command.operation === "stop") process.exit(0);
		} catch (error) { await write({ type: "reply", requestId: command.requestId, ok: false, error: error instanceof ActiveSessionClientError ? error.code : "worker_error" }); }
	};
	process.stdin.on("data", (chunk: Buffer) => {
		input = Buffer.concat([input, chunk]);
		if (input.length > controlLimit) { process.exit(2); return; }
		let newline;
		while ((newline = input.indexOf(10)) >= 0) { const line = input.subarray(0, newline); input = input.subarray(newline + 1); queue = queue.then(() => handle(line)).catch(() => process.exit(2)); }
	});
}

if (workerMode) await runWorker();

async function ownedProfile() {
	const root = await mkdtemp(join(tmpdir(), "gentle-node-"));
	const agentHome = process.platform === "win32" ? root : `C:\\${basename(root)}`;
	return { root, agentHome };
}

const waitFor = async <T>(operation: Promise<T>, timeoutMs = 2_000) => {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([operation, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("timed out")), timeoutMs); })]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
};

const deferred = <T = void>() => {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((next, fail) => { resolve = next; reject = fail; });
	return { promise, resolve, reject };
};
type SendResult = Awaited<ReturnType<ActiveSessionClient["sendNotification"]>>;
type Outcome<T> = Readonly<{ status: "fulfilled"; value: T }> | Readonly<{ status: "rejected"; error: unknown }>;
const observe = <T>(operation: Promise<T>): Promise<Outcome<T>> => operation.then(
	(value) => Object.freeze({ status: "fulfilled" as const, value }),
	(error) => Object.freeze({ status: "rejected" as const, error }),
);
const outcomeText = <T>(outcome: Outcome<T>) => outcome.status === "fulfilled" ? "fulfilled" : `rejected:${outcome.error instanceof Error ? outcome.error.message : String(outcome.error)}`;

type WorkerMessage = Readonly<{ type: "ready" | "reply" | "callback"; requestId?: string; ok?: boolean; result?: Record<string, unknown>; error?: string; id?: string; senderSessionId?: string; message?: string }>;
type WorkerHandle = Readonly<{ process: ChildProcessWithoutNullStreams; ready: Promise<void>; command: (operation: "send" | "stop", values?: Record<string, unknown>) => Promise<Record<string, unknown>>; event: (id: string) => Promise<WorkerMessage>; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }> }>;
const launchWorker = (agentHome: string, sessionId: string): WorkerHandle => {
	const environment = { ...process.env };
	delete environment.NODE_TEST_CONTEXT;
	environment.GENTLE_NODE_WORKER = "1";
	environment.GENTLE_AGENT_HOME = agentHome;
	environment.GENTLE_NODE_SESSION = sessionId;
	const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url)], { env: environment, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
	const pending = new Map<string, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	const callbacks: WorkerMessage[] = [];
	const waiters: Array<{ id: string; resolve: (value: WorkerMessage) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
	let partial = Buffer.alloc(0), sequence = 0, terminalCause: Error | undefined, readyResolve!: () => void, readyReject!: (error: Error) => void;
	const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
	void ready.catch(() => undefined);
	let closeResolve!: (value: { code: number | null; signal: NodeJS.Signals | null }) => void;
	const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => { closeResolve = resolve; });
	const failure = new Error("Windows Node child exited before response");
	const rejectPending = (error: Error) => {
		terminalCause ??= error;
		for (const current of pending.values()) { clearTimeout(current.timer); current.reject(terminalCause); }
		pending.clear();
		for (const waiter of waiters.splice(0)) { clearTimeout(waiter.timer); waiter.reject(terminalCause); }
		readyReject(terminalCause);
	};
	const receive = (line: Buffer) => {
		let message: WorkerMessage;
		try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)) as WorkerMessage; } catch { rejectPending(new Error("Windows Node child emitted invalid control data")); return; }
		if (message.type === "ready") { readyResolve(); return; }
		if (message.type === "callback") { const waiter = waiters.find((value) => value.id === message.id); if (waiter) { waiters.splice(waiters.indexOf(waiter), 1); clearTimeout(waiter.timer); waiter.resolve(message); } else if (callbacks.length < 64) callbacks.push(message); else rejectPending(new Error("Windows Node child callback queue exceeded bound")); return; }
		if (message.type === "reply" && message.requestId) { const current = pending.get(message.requestId); if (!current) return; pending.delete(message.requestId); clearTimeout(current.timer); if (message.ok) current.resolve(message.result ?? {}); else current.reject(new Error(message.error ?? "Windows Node child command failed")); }
	};
	child.stdout.on("data", (chunk: Buffer) => { partial = Buffer.concat([partial, chunk]); if (partial.length > controlLimit) { rejectPending(new Error("Windows Node child control data exceeded bound")); return; } let newline; while ((newline = partial.indexOf(10)) >= 0) { receive(partial.subarray(0, newline)); partial = partial.subarray(newline + 1); } });
	child.stderr.resume();
	child.stdout.on("error", (error) => rejectPending(error));
	child.stdin.on("error", (error) => rejectPending(error));
	child.once("error", (error) => rejectPending(error));
	child.once("close", (code, signal) => { rejectPending(failure); closeResolve({ code, signal }); });
	const command = (operation: "send" | "stop", values: Record<string, unknown> = {}) => {
		if (terminalCause) return Promise.reject(terminalCause);
		const requestId = `command-${++sequence}`, line = JSON.stringify({ requestId, operation, ...values });
		return new Promise<Record<string, unknown>>((resolve, reject) => {
			const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`timed out waiting for child ${operation}`)); }, 3_000);
			pending.set(requestId, { resolve, reject, timer });
			try { child.stdin.write(`${line}\n`, (error) => { if (error) { pending.delete(requestId); clearTimeout(timer); reject(error); } }); } catch (error) { pending.delete(requestId); clearTimeout(timer); reject(error instanceof Error ? error : new Error("child input failed")); }
		});
	};
	const event = (id: string) => {
		if (terminalCause) return Promise.reject(terminalCause);
		return new Promise<WorkerMessage>((resolve, reject) => { const found = callbacks.findIndex((value) => value.id === id); if (found >= 0) { resolve(callbacks.splice(found, 1)[0]); return; } const timer = setTimeout(() => { const index = waiters.findIndex((value) => value.id === id); if (index >= 0) waiters.splice(index, 1); reject(new Error(`timed out waiting for callback ${id}`)); }, 3_000); waiters.push({ id, resolve, reject, timer }); });
	};
	return Object.freeze({ process: child, ready, command, event, closed });
};
const stopWorker = async (child: WorkerHandle) => {
	try { if (child.process.exitCode === null) await child.command("stop"); } catch {}
	try { await waitFor(child.closed); return true; } catch {}
	if (child.process.exitCode === null) { try { child.process.kill(); } catch {} }
	try { await waitFor(child.closed); return true; } catch { return false; }
};

if (!workerMode) {
nodeTest("Windows Node metadata derives isolated bounded paths without traversal", async () => {
	const first = await ownedProfile(), second = await ownedProfile();
	try {
		const paths = windowsNodeTransportPaths(first.agentHome);
		assert.notEqual(paths.root, windowsNodeTransportPaths(second.agentHome).root);
		assert.match(paths.root, /windows-node\\[a-f0-9]{32}$/);
		assert.throws(() => windowsNodeTransportPaths(`${first.agentHome}\\..\\other`), /unsafe transport path/);
	} finally {
		await rm(first.root, { recursive: true, force: true });
		await rm(second.root, { recursive: true, force: true });
	}
});

nodeTest("Windows Node pipe names retain the required prefix and reject forged tokens", () => {
	const pipe = windowsNodePipeName("a".repeat(32), "b".repeat(22));
	assert.match(pipe, /^\\\\\.\\pipe\\gentle-pi-a{32}-b{22}$/);
	assert.throws(() => windowsNodePipeName("a".repeat(22), "b".repeat(22)), /unsafe transport path/);
	assert.throws(() => windowsNodePipeName("../escape", "b".repeat(22)), /unsafe transport path/);
});

async function registry() {
	const fixture = await ownedProfile();
	try {
		const transport = await WindowsNodeSessionPresenceRegistry.create(fixture.agentHome);
		return { ...fixture, transport };
	} catch (error) {
		await rm(fixture.root, { recursive: true, force: true });
		throw error;
	}
}

test("Windows Node publication is exclusive for one activation target", async () => {
	const { root, transport } = await registry();
	try {
		const first = await transport.record("collision", 1), competing = { ...first, createdAt: 2 };
		await transport.publish(first);
		await assert.rejects(transport.publish(competing), (error: unknown) => error instanceof SessionPresenceError && error.code === "busy");
		assert.deepEqual(await transport.resolve(first.sessionId), first);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test("Windows Node independent children exchange both directions and clean activations", async () => {
	const root = await mkdtemp(join(tmpdir(), "gentle-node-e2e-"));
	const children: WorkerHandle[] = [];
	let registry: WindowsNodeSessionPresenceRegistry | undefined;
	let primaryError: unknown;
	let cleanupError: unknown;
	try {
		registry = await WindowsNodeSessionPresenceRegistry.create(root);
		const alphaId = `alpha-${randomBytes(5).toString("hex")}`, betaId = `beta-${randomBytes(5).toString("hex")}`;
		const alpha = launchWorker(root, alphaId);
		children.push(alpha);
		const beta = launchWorker(root, betaId);
		children.push(beta);
		await waitFor(Promise.all([alpha.ready, beta.ready]));
		assert.notEqual(alpha.process.pid, beta.process.pid, "transport peers run in two independent Node processes");
		assert.deepEqual((await registry.listActivations()).map((record) => record.sessionId).sort(), [alphaId, betaId].sort(), "both child IDs are discoverable");
		const alphaToBeta = "alpha-to-beta", betaToAlpha = "beta-to-alpha";
		await alpha.command("send", { recipientSessionId: betaId, id: alphaToBeta, message: "from alpha" });
		const receivedByBeta = await waitFor(beta.event(alphaToBeta));
		assert.deepEqual({ id: receivedByBeta.id, senderSessionId: receivedByBeta.senderSessionId, message: receivedByBeta.message }, { id: alphaToBeta, senderSessionId: alphaId, message: "from alpha" });
		await beta.command("send", { recipientSessionId: alphaId, id: betaToAlpha, message: "from beta" });
		const receivedByAlpha = await waitFor(alpha.event(betaToAlpha));
		assert.deepEqual({ id: receivedByAlpha.id, senderSessionId: receivedByAlpha.senderSessionId, message: receivedByAlpha.message }, { id: betaToAlpha, senderSessionId: betaId, message: "from beta" });
		await alpha.command("stop"); const alphaExit = await waitFor(alpha.closed);
		assert.equal(alphaExit.code, 0, "alpha exited cleanly after listener close");
		assert.deepEqual((await registry.listActivations()).map((record) => record.sessionId), [betaId], "closing alpha removes only beta remains");
		await beta.command("stop"); const betaExit = await waitFor(beta.closed);
		assert.equal(betaExit.code, 0, "beta exited cleanly after listener close");
		assert.deepEqual((await registry.listActivations()).map((record) => record.sessionId), [], "closing beta removes the final activation");
	} catch (error) { primaryError = error; }
	finally {
		let allClosed = true;
		for (const child of children) {
			if (!await stopWorker(child)) { allClosed = false; cleanupError ??= new Error("owned Windows Node child did not close"); }
		}
		if (allClosed) { try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; } }
		else cleanupError ??= new Error("retaining owned test root because child closure is uncertain");
	}
	if (primaryError !== undefined) throw primaryError;
	if (cleanupError !== undefined) throw cleanupError;
});

// These cases are same-process native Windows pilot coverage, not the later
// two-process acceptance proof. They are RED against the loadable skeleton.
test("Windows Node listener publishes discovery and removes its activation on close", async () => {
	const { root, transport } = await registry();
	let listener: ActiveSessionListener | undefined;
	try {
		listener = new ActiveSessionListener(transport, "recipient", async () => {});
		await listener.start();
		assert.equal((await transport.list()).length, 1);
		await listener.close();
		listener = undefined;
		assert.deepEqual(await transport.list(), []);
	} finally {
		await listener?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Windows Node client holds ACK until callback accepts", async () => {
	const { root, transport } = await registry();
	let listener: ActiveSessionListener | undefined;
	let client: ActiveSessionClient | undefined;
	let sendOutcome: Promise<Outcome<SendResult>> | undefined;
	let primaryError: unknown;
	let cleanupError: unknown;
	const release = deferred<void>();
	try {
		const entered = deferred<void>();
		const received: ReceivedNotification[] = [];
		listener = new ActiveSessionListener(transport, "recipient", async (value) => { entered.resolve(); await release.promise; received.push(value); });
		await listener.start();
		client = new ActiveSessionClient(transport, "sender");
		const observed = observe(client.sendNotification("recipient", "accepted", { id: "accepted-1" }));
		sendOutcome = observed;
		try {
			await waitFor(entered.promise);
		} catch (error) {
			const early = await waitFor(observed);
			assert.fail(`callback did not enter; send outcome: ${outcomeText(early)}; wait error: ${error instanceof Error ? error.message : String(error)}`);
		}
		assert.equal(client.pendingCount, 1, "send remains pending while callback is held");
		release.resolve();
		const outcome = await waitFor(observed);
		assert.equal(outcome.status, "fulfilled", outcomeText(outcome));
		if (outcome.status === "fulfilled") assert.deepEqual(outcome.value, { id: "accepted-1", accepted: true });
		assert.deepEqual(received, [{ id: "accepted-1", senderSessionId: "sender", message: "accepted" }]);
	} catch (error) {
		primaryError = error;
	} finally {
		release.resolve();
		if (sendOutcome !== undefined) {
			try { await waitFor(sendOutcome); } catch (error) { cleanupError ??= error; }
		}
		client?.close();
		if (client !== undefined && client.pendingCount !== 0) cleanupError ??= new Error(`client pending count: ${client.pendingCount}`);
		try { await listener?.close(); } catch (error) { cleanupError ??= error; }
		try { await rm(root, { recursive: true, force: true }); } catch (error) { cleanupError ??= error; }
	}
	if (primaryError !== undefined) throw primaryError;
	if (cleanupError !== undefined) throw cleanupError;
});

test("Windows Node client returns a rejected ACK when callback rejects", async () => {
	const { root, transport } = await registry();
	let listener: ActiveSessionListener | undefined;
	let client: ActiveSessionClient | undefined;
	try {
		listener = new ActiveSessionListener(transport, "recipient", async () => { throw new Error("reject callback"); });
		await listener.start();
		client = new ActiveSessionClient(transport, "sender");
		await assert.rejects(client.sendNotification("recipient", "rejected", { id: "rejected-1" }), (error: unknown) => error instanceof ActiveSessionClientError && error.code === "remote_rejected");
	} finally {
		client?.close();
		await listener?.close();
		await rm(root, { recursive: true, force: true });
	}
});

test("Windows Node malformed partial clients do not block a second client", async () => {
	const { root, transport } = await registry();
	let listener: ActiveSessionListener | undefined;
	let partial: ReturnType<typeof transport.connectEndpoint> | undefined;
	let client: ActiveSessionClient | undefined;
	try {
		listener = new ActiveSessionListener(transport, "recipient", async () => {});
		await listener.start();
		partial = transport.connectEndpoint(listener.record!.endpoint);
		partial.on("error", () => {});
		await waitFor(once(partial, "connect"));
		partial.write(Buffer.from("{\"version\":1"));
		client = new ActiveSessionClient(transport, "sender");
		await waitFor(client.sendNotification("recipient", "after-partial", { id: "partial-1" }));
	} finally {
		client?.close();
		if (client !== undefined && client.pendingCount !== 0) await waitFor(Promise.resolve().then(() => { assert.equal(client!.pendingCount, 0); }));
		if (partial !== undefined && !partial.destroyed) {
			const closed = once(partial, "close");
				partial.destroy();
			await waitFor(closed);
		}
		await listener?.close();
		await rm(root, { recursive: true, force: true });
	}
});
}
