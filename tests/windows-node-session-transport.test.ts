import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import nodeTest from "node:test";
import { ActiveSessionClient, ActiveSessionClientError, ActiveSessionListener, SessionPresenceError, type ReceivedNotification } from "../lib/agents-session-transport.ts";
import { WindowsNodeSessionPresenceRegistry, windowsNodePipeName, windowsNodeTransportPaths } from "../lib/windows-node-session-transport.ts";

const test = process.platform === "win32" ? nodeTest : nodeTest.skip;

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
