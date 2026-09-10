import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import { parseFixtureLine, runNativeBoundaryFixture } from "./windows-native-boundary/probe.mjs";

const script = resolve("tests/windows-native-boundary/native.ps1");
const result = JSON.stringify({ schema: "gentle-pi.windows-native-boundary/v1", ok: true, architecture: "x64", elevated: false, stages: ["abi", "anchored-open", "dacl", "identity", "replace-delete", "reparse-negative"], scope: "private-disposable-root" });

function injected(source: string, timeoutMs = 150) {
	let child;
	const operation = runNativeBoundaryFixture({ command: process.execPath, script, timeoutMs, args: ["--input-type=module", "--eval", source], spawnProcess: (...args) => { child = spawn(...args); return child; } });
	return { operation, child: () => child };
}

test("native-boundary parser accepts only the bounded allowlisted schema", () => {
	assert.deepEqual(parseFixtureLine('{"schema":"gentle-pi.windows-native-boundary/v1","ok":false,"stage":"cleanup","architecture":"x64","elevated":false}\n'), { schema: "gentle-pi.windows-native-boundary/v1", ok: false, stage: "cleanup", architecture: "x64", elevated: false });
	for (const line of ["not json\n", '{"schema":"wrong","ok":true,"stage":"abi","architecture":"x64","elevated":false}\n', '{"schema":"gentle-pi.windows-native-boundary/v1","ok":false,"stage":"unknown","architecture":"x64","elevated":false}\n', '{"schema":"gentle-pi.windows-native-boundary/v1","ok":true,"architecture":"x64","elevated":false,"stages":[],"scope":"private-disposable-root","sid":"secret"}\n', "x".repeat(16_385)]) assert.throws(() => parseFixtureLine(line));
});

test("native-boundary source precomputes ABI values and checks typed tombstone status", () => {
	const source = readFileSync(script, "utf8");
	assert.match(source, /\$expectedUnicodeSize\s*=\s*if\s*\(/);
	assert.doesNotMatch(source, /UnicodeStringSize\(\)\s*-ne\s*\(if\s*\(/);
	assert.match(source, /STATUS_OBJECT_NAME_NOT_FOUND/);
	assert.match(source, /postCloseReplacement/);
});

test("native-boundary runner rejects unavailable hosts", async () => {
	await assert.rejects(runNativeBoundaryFixture({ command: "/definitely/missing/powershell.exe", script, timeoutMs: 20 }), /unavailable/);
});

test("native-boundary runner waits for final output, cleanup delay, and normal exit", async () => {
	const fixture = injected(`setTimeout(() => { process.stdout.write(${JSON.stringify(`${result}\n`)}); process.exit(0); }, 35)`);
	const value = await fixture.operation;
	const child = fixture.child();
	assert.equal(value.ok, true);
	assert.equal(child.exitCode, 0);
	assert.equal(child.signalCode, null);
});

test("native-boundary runner exposes only an allowlisted stage for a nonzero native failure", async () => {
	const rawDetail = "S-1-5-21-untrusted";
	const failed = JSON.stringify({ schema: "gentle-pi.windows-native-boundary/v1", ok: false, stage: "dacl", architecture: "x64", elevated: false });
	const fixture = injected(`process.stdout.write(${JSON.stringify(`${failed}\n`)}); process.stderr.write(${JSON.stringify(rawDetail)}); process.exit(2)`);
	await assert.rejects(fixture.operation, (error: Error) => {
		assert.match(error.message, /^native-boundary host failed \(category: nonzero-exit\) \(stage: dacl\)$/);
		assert.doesNotMatch(error.message, /S-1-5-21-untrusted/);
		return true;
	});
	const child = fixture.child();
	assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("native-boundary runner rejects malformed failure details and never passes an ok false result", async () => {
	const rawDetail = "S-1-5-21-untrusted";
	for (const output of [
		JSON.stringify({ schema: "gentle-pi.windows-native-boundary/v1", ok: false, stage: "unknown", architecture: "x64", elevated: false }),
		JSON.stringify({ schema: "gentle-pi.windows-native-boundary/v1", ok: false, stage: "dacl", architecture: "x64", elevated: false, detail: rawDetail }),
	]) {
		const fixture = injected(`process.stdout.write(${JSON.stringify(`${output}\n`)}); process.exit(2)`);
		await assert.rejects(fixture.operation, (error: Error) => {
			assert.match(error.message, /malformed native-boundary result/);
			assert.doesNotMatch(error.message, /S-1-5-21-untrusted/);
			return true;
		});
		const child = fixture.child();
		assert.ok(child.exitCode !== null || child.signalCode !== null);
	}
	const failed = JSON.stringify({ schema: "gentle-pi.windows-native-boundary/v1", ok: false, stage: "cleanup", architecture: "x64", elevated: false });
	const fixture = injected(`process.stdout.write(${JSON.stringify(`${failed}\n`)}); process.exit(0)`);
	await assert.rejects(fixture.operation, (error: Error) => {
		assert.match(error.message, /^native-boundary host failed \(category: host-failure\) \(stage: cleanup\)$/);
		return true;
	});
	const child = fixture.child();
	assert.ok(child.exitCode !== null || child.signalCode !== null);
	const signalled = injected(`process.stdout.write(${JSON.stringify(`${result}\n`)}); setTimeout(() => process.kill(process.pid, "SIGTERM"), 5)`);
	await assert.rejects(signalled.operation, (error: Error) => {
		const terminatedChild = signalled.child();
			const category = terminatedChild.signalCode !== null ? "signal" : "nonzero-exit";
			if (terminatedChild.signalCode === null) {
				assert.notEqual(terminatedChild.exitCode, null);
				assert.notEqual(terminatedChild.exitCode, 0);
			}
			assert.equal(error.message, `native-boundary host failed (category: ${category}) (stage: complete)`);
		return true;
	});
	const signalledChild = signalled.child();
	assert.ok(signalledChild.exitCode !== null || signalledChild.signalCode !== null);
});

for (const [name, source, timeoutMs, expected] of [
	["malformed", "process.stdout.write('not json\\n'); process.exit(2)", 150, /malformed/],
	["oversized", "process.stdout.write('x'.repeat(16385)); process.exit(2)", 150, /malformed/],
	["timeout", "setInterval(() => {}, 1000)", 30, /timeout/],
] as const) test(`native-boundary runner fails closed for ${name} output and settles its child`, async () => {
	const fixture = injected(source, timeoutMs);
	await assert.rejects(fixture.operation, expected);
	const child = fixture.child();
	assert.ok(child.exitCode !== null || child.signalCode !== null);
});

test("native-boundary fixture is available only on Windows", { skip: process.platform !== "win32" }, async (t) => {
	assert.equal(existsSync(script), true);
	const value = await runNativeBoundaryFixture({ script, timeoutMs: 15_000 });
	t.diagnostic(JSON.stringify(value));
	assert.equal(value.ok, true);
	assert.deepEqual(value.stages, ["abi", "anchored-open", "dacl", "identity", "replace-delete", "reparse-negative"]);
});
