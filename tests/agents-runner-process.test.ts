import assert from "node:assert/strict";
import { spawn as nodeSpawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { AGENT_MODE, type AgentDefinition } from "../lib/agents-config.ts";
import { AgentRunner, type ChildLike, type RunnerDeps, type TaskRequest } from "../lib/agents-runner.ts";
import { TASK_STATUS, TaskStore } from "../lib/agents-protocol.ts";

const fixture = fileURLToPath(new URL("./fixtures/agents-process-child.mjs", import.meta.url));
const ipcFixture = fileURLToPath(new URL("./fixtures/agents-ipc-close-child.mjs", import.meta.url));
const agent: AgentDefinition = { name: "process", description: "test", filePath: "/test.md", scope: "global", instructions: "", model: undefined, thinking: undefined, mode: undefined, tools: [] };
const request = (prompt: string): TaskRequest => ({ agent, prompt, label: undefined, context: undefined, mode: AGENT_MODE.BACKGROUND, cwd: process.cwd(), parentSessionId: "test", model: undefined, thinking: undefined, sessionDir: "/tmp", resumeSessionPath: undefined, env: {} });

const waitFor = async (predicate: () => boolean, timeoutMs = 10_000, label = "condition"): Promise<void> => {
	let interval: ReturnType<typeof setInterval> | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			const check = () => {
				if (predicate()) { resolve(); return; }
				interval ??= setInterval(check, 10);
			};
			timeout = setTimeout(() => reject(new Error(`${label} timeout after ${timeoutMs}ms`)), timeoutMs);
			check();
		});
	} finally {
		if (interval) clearInterval(interval);
		if (timeout) clearTimeout(timeout);
	}
};

test("POSIX cleanup retains queue slots when a leader exits but its TERM-resisting descendant remains", { skip: process.platform === "win32" }, async () => {
	const store = new TaskStore();
	let launches = 0;
	let firstPid: number | undefined;
	const descendantPids: Array<number | undefined> = [];
	let firstDetached = false;
	const ownedPids: number[] = [];
	const runtimeTimers: Array<{ fn: () => void; timer: ReturnType<typeof setTimeout> | undefined; cancelled: boolean }> = [];
	const armRuntimeTimeout = (index: number) => {
		const timer = runtimeTimers[index];
		if (timer && !timer.cancelled && timer.timer === undefined) timer.timer = setTimeout(timer.fn, 500);
	};
	const deps: RunnerDeps = {
		spawn: (_command, _args, options): ChildLike => {
			launches += 1;
			const env = launches === 1 ? { ...options.env, AGENTS_PROCESS_CHILD_EXIT_ON_TERM: "1" } : launches === 3 ? { ...options.env, AGENTS_PROCESS_CHILD_EXIT_AFTER_READY: "1" } : options.env;
			const child = nodeSpawn(process.execPath, [fixture], { cwd: options.cwd, env, detached: options.detached, stdio: options.stdio });
			const launchIndex = launches - 1;
			ownedPids.push(child.pid!);
			if (launches === 1) {
				firstPid = child.pid;
				firstDetached = options.detached === true;
			}
			let output = "";
			child.stdout.on("data", (chunk: Buffer) => {
				output += chunk.toString();
				const match = output.match(/DESCENDANT:(\d+)/);
				if (match) {
					descendantPids[launchIndex] = Number(match[1]);
					armRuntimeTimeout(launchIndex);
				}
			});
			child.on("exit", () => {});
			child.on("close", () => {});
			child.stdout.on("close", () => {});
			child.stderr?.on("close", () => {});
			return child;
		},
		now: Date.now,
		schedule: (fn, ms) => {
			if (ms === 500) {
				const timer = { fn, timer: undefined, cancelled: false };
				const index = launches - 1;
				runtimeTimers[index] = timer;
				if (descendantPids[index] !== undefined) armRuntimeTimeout(index);
				return () => {
					timer.cancelled = true;
					if (timer.timer) clearTimeout(timer.timer);
				};
			}
			const timer = setTimeout(fn, ms);
			return () => clearTimeout(timer);
		},
		pi: { command: process.execPath, args: [fixture] },
	};
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 500 }, deps, { askUser: async () => ({ cancelled: true }) });
	const first = runner.run(request("first"));
	const second = runner.run(request("second"));
	const third = runner.run(request("third"));
	const fourth = runner.run(request("fourth"));
	try {
		await waitFor(() => launches === 1 && descendantPids[0] !== undefined);
		assert.equal(firstDetached, true, "the first child owns a POSIX process group");
		assert.equal(runner.cancel(first.id), true);
		assert.equal(store.get(first.id)?.status, TASK_STATUS.RUNNING, "leader exit does not release its live descendant group");
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.doesNotThrow(() => process.kill(descendantPids[0]!, 0), "the exact TERM-resisting descendant remains alive");
		assert.equal(launches, 1, "the queued task cannot use the slot during SIGTERM grace");
		await waitFor(() => store.get(first.id)?.status === TASK_STATUS.CANCELLED);
		assert.equal(launches, 2, "the slot opens only after the owned group exits");
		assert.throws(() => process.kill(-firstPid!, 0), { code: "ESRCH" }, "SIGKILL cleaned the owned child group, including its descendant");
		await waitFor(() => store.get(second.id)?.status === TASK_STATUS.TIMED_OUT);
		assert.throws(() => process.kill(-ownedPids[1], 0), { code: "ESRCH" }, "timeout also bounds cleanup of its owned group");
		await waitFor(() => launches === 3 && descendantPids[2] !== undefined);
		await new Promise((resolve) => setTimeout(resolve, 40));
		assert.doesNotThrow(() => process.kill(descendantPids[2]!, 0), "the natural-exit descendant remains alive");
		assert.equal(launches, 3, "natural leader exit does not release the queue slot");
		await waitFor(() => store.get(third.id)?.status === TASK_STATUS.FAILED);
		assert.equal(launches, 4, "the queue resumes after natural-exit group cleanup");
		assert.throws(() => process.kill(-ownedPids[2], 0), { code: "ESRCH" }, "natural exit also cleans its owned group");
	} finally {
		if (firstDetached) {
			for (const pid of ownedPids) {
				try { process.kill(-pid, "SIGKILL"); } catch {}
			}
		} else {
			for (const pid of [firstPid, ...descendantPids, ...ownedPids]) {
				if (pid) try { process.kill(pid, "SIGKILL"); } catch {}
			}
		}
		runner.cancel(second.id);
		runner.cancel(third.id);
		runner.cancel(fourth.id);
	}
});

test("POSIX runner preserves real IPC and reports close after exit and stdio close", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
	const events: string[] = [];
	const cleanupErrors: string[] = [];
	let child: ReturnType<typeof nodeSpawn> | undefined;
	let readyObserved = false;
	const ready = () => { readyObserved = true; };
	const store = new TaskStore();
	const runner = new AgentRunner(store, { maxConcurrency: 1, stallTimeoutMs: 5_000 }, {
		spawn: (_command, _args, options) => {
			child = nodeSpawn(process.execPath, [ipcFixture], { cwd: options.cwd, env: options.env, detached: options.detached, stdio: options.stdio });
			child.on("message", (message) => { if (message && typeof message === "object" && (message as { type?: unknown }).type === "ready") ready(); });
			child.on("exit", () => events.push("exit"));
			child.on("close", () => events.push("close"));
			child.stdout.on("close", () => events.push("stdout-close"));
			child.stderr?.on("close", () => events.push("stderr-close"));
			return child;
		},
		now: Date.now,
		schedule: (fn, ms) => { const timer = setTimeout(fn, ms); return () => clearTimeout(timer); },
		pi: { command: process.execPath, args: [] },
	}, { askUser: async () => ({ cancelled: true }) });
	const task = runner.run(request("ipc eof"));
	let failure: unknown;
	try {
		await waitFor(() => readyObserved, 3_000, "framed IPC readiness");
		assert.ok(child?.pid, "ready child has a PID");
		assert.equal(runner.cancel(task.id), true, "cancellation targets the live task");
		await waitFor(() => events.includes("exit") && events.includes("stdout-close") && events.includes("stderr-close"), 5_000, "exit and stdio closure");
		await waitFor(() => {
			try { process.kill(child!.pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
		}, 2_000, "child PID disappearance");
		await waitFor(() => {
			try { process.kill(-child!.pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
		}, 2_000, "owned process-group disappearance");
		const closeDeadline = Date.now() + 1_000;
		while (!events.includes("close") && Date.now() < closeDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(events.filter((event) => event === "close").length, 1, "RED diagnosis: missing real child close or duplicate close after proven exit, stdio close, and PID/PGID disappearance");
		assert.ok(events.indexOf("exit") < events.indexOf("close"), "child close follows child exit");
		await waitFor(() => store.get(task.id)?.status === TASK_STATUS.CANCELLED, 2_000, "runner cancellation cleanup");
	} catch (error) {
		failure = error;
	} finally {
		if (child?.pid) {
			for (const target of [-child.pid, child.pid]) {
				try { process.kill(target, "SIGKILL"); } catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ESRCH") cleanupErrors.push(`SIGKILL ${target}: ${String(error)}`);
				}
			}
			try { await waitFor(() => events.includes("exit"), 1_000, "cleanup child exit"); } catch (error) { cleanupErrors.push(String(error)); }
			try { await waitFor(() => {
				try { process.kill(child!.pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
			}, 1_000, "cleanup PID disappearance"); } catch (error) { cleanupErrors.push(String(error)); }
			try { await waitFor(() => {
				try { process.kill(-child!.pid!, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
			}, 1_000, "cleanup process-group disappearance"); } catch (error) { cleanupErrors.push(String(error)); }
		}
		runner.cancel(task.id);
		try { await waitFor(() => store.get(task.id)?.status === TASK_STATUS.CANCELLED, 1_000, "cleanup runner cancellation"); } catch (error) { cleanupErrors.push(String(error)); }
	}
	if (failure) throw new AggregateError([failure, ...cleanupErrors.map((error) => new Error(error))], "RED regression or cleanup failure");
	assert.deepEqual(cleanupErrors, [], `cleanup failure: ${cleanupErrors.join("; ")}`);
});
