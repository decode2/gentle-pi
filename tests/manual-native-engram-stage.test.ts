import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as staging from "../scripts/manual-native-engram-stage.mjs";
import {
	MAX_BINARY_BYTES,
	archiveReaderArgs,
	assertBinaryIdentity,
	assertRealDirectoryChain,
	assertRegularLeaf,
	checkReaderExecutable,
	exclusiveBinaryWriteFlags,
	selectEngramMember,
} from "../scripts/manual-native-engram-stage.mjs";

const regular = (name, size = 1) => ({ name, type: "file", size });

function crc32(bytes: Buffer) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries: Array<{ name: string; data: Buffer }>) {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "ascii");
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt32LE(crc32(entry.data), 14);
		local.writeUInt32LE(entry.data.length, 18);
		local.writeUInt32LE(entry.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(Buffer.concat([local, name, entry.data]));
		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE((3 << 8) | 20, 4);
		header.writeUInt32LE(crc32(entry.data), 16);
		header.writeUInt32LE(entry.data.length, 20);
		header.writeUInt32LE(entry.data.length, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt32LE((0o100644 * 0x10000) >>> 0, 38);
		header.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([header, name]));
		offset += locals.at(-1)!.length;
	}
	const localBytes = Buffer.concat(locals);
	const centralBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(localBytes.length, 16);
	return Buffer.concat([localBytes, centralBytes, end]);
}

const windowsMembers = ["tools/cloud-sync-projects.ps1", "tools/cloud-sync-projects.sh", "engram.exe"];
const archiveDigest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const windowsZip = (binary = Buffer.from("synthetic executable"), names = windowsMembers) => zip(names.map((name) => ({
	name,
	data: name === "engram.exe" ? binary : Buffer.from("script"),
})));

function readerDependencies(overrides = {}) {
	return {
		operation: "list",
		checkExecutable: async () => "/native/archive-reader",
		checkCwd: async () => {},
		spawnSync: () => ({ status: 0, stdout: Buffer.from("member\n") }),
		...overrides,
	};
}

function assertFailureCode(error, expected) {
	assert.equal(staging.safeFailureCode(error), expected);
	assert.equal(error.message.includes("HOSTILE_SENTINEL"), false);
}

// Pure guard tests: no archive extraction, executable invocation, or scratch writes.
test("keeps the Darwin tar reader modes and rejects ZIP reader arguments", () => {
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_darwin_arm64.tar.gz", "list"), ["-tzf", "-"]);
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_darwin_arm64.tar.gz", "verbose"), ["-tvzf", "-"]);
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_darwin_arm64.tar.gz", "extract", "engram"), ["-xOzf", "-", "engram"]);
	assert.throws(() => archiveReaderArgs("engram_2.1.0_windows_amd64.zip", "list"), /unsupported archive format/);
	assert.throws(() => archiveReaderArgs("archive.tgz", "list"), /unsupported archive format/);
});

test("routes Windows ZIP members through same-buffer validation and extraction only", async () => {
	const bytes = windowsZip();
	const asset = { name: "synthetic.zip", sha256: archiveDigest(bytes) };
	let readerCalls = 0;
	let writes = 0;
	const disposition = await staging.stageVerifiedArchiveMember(bytes, asset, "win32", "x64", "/synthetic", {
		runNativeReader: async () => { readerCalls++; throw new Error("HOSTILE_SENTINEL"); },
		stageDarwin: async () => { writes++; },
	});
	assert.equal(disposition, "member-validation-memory-only");
	assert.equal(readerCalls, 0);
	assert.equal(writes, 0);
});

test("closes Windows digest, manifest, extra-member, and CRC failures safely", async () => {
	const valid = windowsZip();
	const asset = { name: "synthetic.zip", sha256: archiveDigest(valid) };
	const run = async (bytes: Buffer, selectedAsset = { name: "synthetic.zip", sha256: archiveDigest(bytes) }) => {
		try { await staging.stageVerifiedArchiveMember(bytes, selectedAsset, "win32", "x64", "/synthetic"); } catch (error) { return error; }
		assert.fail("expected validation failure");
	};
	for (const [bytes, selectedAsset] of [
		[valid, { name: "synthetic.zip", sha256: "0".repeat(64) }],
		[windowsZip(Buffer.from("synthetic executable"), [...windowsMembers.slice(0, 2), "wrong.exe"]), undefined],
		[windowsZip(Buffer.from("synthetic executable"), [...windowsMembers, "extra.txt"]), undefined],
	] as const) {
		const error = await run(bytes, selectedAsset ?? { name: "synthetic.zip", sha256: archiveDigest(bytes) });
		assert.equal(staging.safeFailureCode(error), "member-validation-zip-validation");
		assert.equal((error as Error).message.includes("HOSTILE_SENTINEL"), false);
	}
	const corrupt = Buffer.from(valid);
	const nameOffset = corrupt.indexOf(Buffer.from("engram.exe"));
	corrupt[nameOffset + Buffer.byteLength("engram.exe")] ^= 1;
	const crcError = await run(corrupt);
	assert.equal(staging.safeFailureCode(crcError), "member-validation-zip-extraction");
});

test("keeps Darwin on the injected native-reader and scratch-stage path", async () => {
	const bytes = Buffer.from("verified tar archive");
	const binary = Buffer.from("Darwin member");
	const operations: string[] = [];
	let staged: Buffer | undefined;
	const disposition = await staging.stageVerifiedArchiveMember(bytes, { name: "darwin.tar.gz" }, "darwin", "arm64", "/synthetic", {
		runNativeReader: async (_archive: Buffer, args: string[], _cwd: string, _limit: number, options: { operation: string }) => {
			operations.push(options.operation);
			if (options.operation === "list") return Buffer.from("tools/cloud-sync-projects.ps1\ntools/cloud-sync-projects.sh\nengram\n");
			if (options.operation === "verbose") return Buffer.from("-script\n-script\n-binary\n");
			return binary;
		},
		stageDarwin: async (member: Buffer) => { staged = member; },
	});
	assert.equal(disposition, "staged");
	assert.deepEqual(operations, ["list", "verbose", "extract"]);
	assert.deepEqual(staged, binary);
});

test("selects only the exact root-level native Engram member", () => {
	const entries = [regular("tools/cloud-sync-projects.ps1", 4980), regular("tools/cloud-sync-projects.sh", 3340), regular("engram", 20)];
	assert.deepEqual(selectEngramMember(entries, "engram"), regular("engram", 20));
	assert.equal(selectEngramMember([regular("engram.exe")], "engram.exe").name, "engram.exe");
});

test("rejects missing, duplicate, unsafe, and oversized archive members", () => {
	assert.throws(() => selectEngramMember([regular("other")], "engram"), /missing archive member/);
	assert.throws(() => selectEngramMember([regular("engram"), regular("engram")], "engram"), /duplicate archive member/);
	for (const name of ["../engram", "/engram", "tools/../../engram", "tools\\engram", "bad\0name"]) {
		assert.throws(() => selectEngramMember([regular(name), regular("engram")], "engram"), /unsafe archive member/);
	}
	assert.throws(() => selectEngramMember([regular("engram", MAX_BINARY_BYTES + 1)], "engram"), /oversized archive member/);
});

test("rejects symlink members and symlinked archive directories", () => {
	assert.throws(() => selectEngramMember([{ name: "engram", type: "symlink", size: 0 }], "engram"), /non-regular archive member/);
	assert.throws(() => selectEngramMember([{ name: "tools", type: "symlink", size: 0 }, regular("engram")], "engram"), /non-regular archive member/);
	assert.throws(() => selectEngramMember([{ name: "tools", type: "directory", size: 0 }, regular("engram")], "engram"), /non-regular archive member/);
});

test("whitelists injected diagnostics and preserves Windows memory-only behavior", async () => {
	const writes = [];
	assert.equal(await staging.deliverEngramMember("win32", Buffer.from("verified member"), async (bytes) => writes.push(bytes)), "member-validation-memory-only");
	assert.deepEqual(writes, []);
	const error = await staging.withFailureReason("archive-read", async () => { throw new Error("HOSTILE_SENTINEL /private/path"); }).catch((failure) => failure);
	assert.equal(staging.safeFailureCode(error), "member-validation-archive-read");
	const unlisted = await staging.withFailureReason("HOSTILE_SENTINEL", async () => { throw new Error("HOSTILE_SENTINEL"); }).catch((failure) => failure);
	assert.equal(staging.safeFailureCode(unlisted), "unknown");
	assert.equal(staging.safeFailureCode(new Error("HOSTILE_SENTINEL /private/path")), "unknown");
	const script = fileURLToPath(new URL("../scripts/manual-native-engram-stage.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script, "invalid"], { encoding: "utf8", env: {} });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "unknown\n");
});

test("classifies injected reader failures by each closed operation label", async () => {
	const hostile = () => { throw new Error("HOSTILE_SENTINEL /private/path --raw-arg"); };
	const failures = [
		["executable", { checkExecutable: async () => hostile() }],
		["cwd", { checkCwd: async () => hostile() }],
		["spawn", { spawnSync: hostile }],
		["spawn", { spawnSync: () => ({ error: new Error("HOSTILE_SENTINEL") }) }],
		["exit", { spawnSync: () => ({ status: 7, stdout: Buffer.from("HOSTILE_SENTINEL") }) }],
		["zero-output", { spawnSync: () => ({ status: 0, stdout: Buffer.alloc(0) }) }],
	];
	for (const operation of ["list", "verbose", "extract"]) {
		for (const [condition, overrides] of failures) {
			const error = await staging.runNativeReader(Buffer.from("archive"), ["--HOSTILE_SENTINEL"], "/private/HOSTILE_SENTINEL", 1024, readerDependencies({ ...overrides, operation })).catch((failure) => failure);
			assertFailureCode(error, `member-validation-native-reader-${operation}-${condition}`);
		}
	}
	const output = Buffer.from("member\n");
	assert.equal(await staging.runNativeReader(Buffer.from("archive"), [], "/safe/cwd", 1024, readerDependencies({
		operation: "extract",
		spawnSync: () => ({ status: 0, stdout: output }),
	})), output);
});

test("uses only the fixed Darwin bsdtar reader and rejects unsafe targets safely", async () => {
	const checked = [];
	const inspectRegular = async (path) => {
		checked.push(["lstat", path]);
		return { isFile: () => true, isSymbolicLink: () => false };
	};
	assert.equal(await checkReaderExecutable("darwin", { PATH: "/hostile" }, {
		assertRealDirectoryChain: async (path) => checked.push(["directory", path]),
		lstat: inspectRegular,
	}), "/usr/bin/bsdtar");
	assert.deepEqual(checked, [["directory", "/usr/bin"], ["lstat", "/usr/bin/bsdtar"]]);

	let invoked = false;
	for (const details of [
		{ isFile: () => true, isSymbolicLink: () => true },
		{ isFile: () => false, isSymbolicLink: () => false },
	]) {
		const error = await staging.runNativeReader(Buffer.from("archive"), [], "/safe/cwd", 1024, {
			operation: "list",
			platform: "darwin",
			environment: { PATH: "/hostile" },
			checkExecutable: () => checkReaderExecutable("darwin", { PATH: "/hostile" }, {
				assertRealDirectoryChain: async () => {}, lstat: async () => details,
			}),
			checkCwd: async () => {},
			spawnSync: () => { invoked = true; return { status: 0, stdout: Buffer.from("member\\n") }; },
		}).catch((failure) => failure);
		assertFailureCode(error, "member-validation-native-reader-list-executable");
	}
	assert.equal(invoked, false);

	let invocation;
	await staging.runNativeReader(Buffer.from("archive"), [], "/safe/cwd", 1024, {
		operation: "list",
		platform: "darwin",
		environment: { PATH: "/hostile", SECRET: "HOSTILE_SENTINEL" },
		checkExecutable: () => checkReaderExecutable("darwin", { PATH: "/hostile" }, {
			assertRealDirectoryChain: async () => {}, lstat: inspectRegular,
		}),
		checkCwd: async () => {},
		spawnSync: (executable, args, options) => {
			invocation = { executable, env: options.env };
			return { status: 0, stdout: Buffer.from("member\\n") };
		},
	});
	assert.deepEqual(invocation, { executable: "/usr/bin/bsdtar", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });

	const windowsLeaves = [];
	assert.equal(await checkReaderExecutable("win32", { SystemRoot: "C:\\Windows", PATH: "/hostile" }, {
		assertRealDirectoryChain: async () => {},
		lstat: async (path) => { windowsLeaves.push(path); return { isFile: () => true, isSymbolicLink: () => false }; },
	}), "C:\\Windows\\System32\\tar.exe");
	assert.deepEqual(windowsLeaves, ["C:\\Windows\\System32\\tar.exe"]);
});

test("rejects hostile reader operation labels without deriving a public code", async () => {
	let invoked = false;
	const dependencies = readerDependencies({
		operation: "HOSTILE_SENTINEL/phase",
		checkExecutable: async () => { invoked = true; return "/private/HOSTILE_SENTINEL"; },
		spawnSync: () => { invoked = true; throw new Error("HOSTILE_SENTINEL"); },
	});
	const error = await staging.runNativeReader(Buffer.from("archive"), ["--HOSTILE_SENTINEL"], "/private/HOSTILE_SENTINEL", 1024, dependencies).catch((failure) => failure);
	assertFailureCode(error, "unknown");
	assert.equal(invoked, false);
	let phaseError;
	try { staging.parseReaderOutput(Buffer.from("member\\n"), "HOSTILE_SENTINEL/phase"); } catch (failure) { phaseError = failure; }
	assertFailureCode(phaseError, "unknown");
});

test("separates invalid UTF-8, empty, newline, and malformed reader output", () => {
	for (const phase of ["list", "verbose"]) {
		const prefix = `member-validation-native-reader-${phase}`;
		assert.deepEqual(staging.parseReaderOutput(Buffer.from("member\n"), phase), ["member"]);
		for (const [bytes, suffix] of [
			[Buffer.from([0xff]), "invalid-utf8"],
			[Buffer.alloc(0), "empty-output"],
			[Buffer.from("member"), "newline"],
			[Buffer.from("member\n\n"), "empty-output"],
			[Buffer.from("member\rbroken\n"), "malformed-output"],
		]) {
			let error;
			try { staging.parseReaderOutput(bytes, phase); } catch (failure) { error = failure; }
			assertFailureCode(error, `${prefix}-${suffix}`);
		}
	}
});

test("preserves only stage-approved nested diagnostics", async () => {
	const arbitraryNested = await staging.withFailureReason("native-reader-list", async () => { throw new Error("HOSTILE_SENTINEL"); }).catch((failure) => failure);
	assert.equal(staging.safeFailureCode(arbitraryNested), "unknown");
	const cases = [["native-reader-list", "archive-read", "member-validation-native-reader-list"],
		["native-reader-list", "native-reader-invocation", "member-validation-native-reader-invocation"],
		["native-reader-list", "native-reader-list-executable", "member-validation-native-reader-list-executable"],
		["native-reader-list", "native-reader-list-invalid-utf8", "member-validation-native-reader-list-invalid-utf8"],
		["native-reader-verbose", "native-reader-invocation", "member-validation-native-reader-invocation"],
		["native-reader-verbose", "native-reader-verbose-zero-output", "member-validation-native-reader-verbose-zero-output"],
		["native-reader-verbose", "native-reader-verbose-newline", "member-validation-native-reader-verbose-newline"],
		["native-reader-extract", "native-reader-extract-spawn", "member-validation-native-reader-extract-spawn"],
		["native-reader-extract", "darwin-private-root", "member-validation-darwin-private-root"],
		["native-reader-extract", "darwin-write", "member-validation-darwin-write"],
		["native-reader-extract", "darwin-readback", "member-validation-darwin-readback"],
	];
	for (const [outer, inner, expected] of cases) {
		const error = await staging.withFailureReason(outer, () => staging.withFailureReason(inner, async () => { throw new Error("HOSTILE_SENTINEL"); })).catch((failure) => failure);
		assert.equal(staging.safeFailureCode(error), expected);
		const repeated = await staging.withFailureReason(outer, async () => { throw error; }).catch((failure) => failure);
		assert.equal(staging.safeFailureCode(repeated), expected);
	}
});

test("refuses symlinked filesystem leaves and creates output exclusively without following links", () => {
	assert.throws(() => assertRegularLeaf({ isFile: () => true, isSymbolicLink: () => true, size: 1 }, 10), /unsafe staged binary leaf/);
	assert.throws(() => assertRegularLeaf({ isFile: () => true, isSymbolicLink: () => false, size: 11 }, 10), /oversized staged artifact/);
	const flags = exclusiveBinaryWriteFlags();
	assert.notEqual(flags & constants.O_EXCL, 0);
	assert.notEqual(flags & constants.O_CREAT, 0);
	if (constants.O_NOFOLLOW !== undefined) assert.notEqual(flags & constants.O_NOFOLLOW, 0);
});

test("refuses symlinked or non-directory filesystem ancestors", async () => {
	const root = resolve(tmpdir());
	const target = join(root, "native-stage-test", "bin");
	const linked = join(root, "native-stage-test");
	const inspect = async (path) => ({
		isDirectory: () => true,
		isSymbolicLink: () => path === linked,
	});
	await assert.rejects(assertRealDirectoryChain(target, inspect), /unsafe scratch directory or symlink ancestor/);
	await assert.doesNotReject(assertRealDirectoryChain(target, async () => ({ isDirectory: () => true, isSymbolicLink: () => false })));
	await assert.rejects(assertRealDirectoryChain(target, async () => ({ isDirectory: () => false, isSymbolicLink: () => false })), /unsafe scratch directory or symlink ancestor/);
});

test("verifies staged bytes against the immutable extracted buffer", () => {
	const extracted = Buffer.from("pinned executable bytes");
	assert.equal(assertBinaryIdentity(extracted, Buffer.from(extracted)), true);
	assert.throws(() => assertBinaryIdentity(extracted, Buffer.from("changed")), /binary identity mismatch/);
	assert.throws(() => assertBinaryIdentity(Buffer.alloc(MAX_BINARY_BYTES + 1), Buffer.alloc(0)), /oversized binary/);
});
