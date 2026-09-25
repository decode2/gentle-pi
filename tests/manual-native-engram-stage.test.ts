import assert from "node:assert/strict";
import test from "node:test";
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
	exclusiveBinaryWriteFlags,
	selectEngramMember,
} from "../scripts/manual-native-engram-stage.mjs";

const regular = (name, size = 1) => ({ name, type: "file", size });

// Pure guard tests: no archive extraction, executable invocation, or scratch writes.
test("uses explicit stdin reader modes for the pinned gzip and ZIP formats", () => {
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_darwin_arm64.tar.gz", "list"), ["-tzf", "-"]);
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_darwin_arm64.tar.gz", "verbose"), ["-tvzf", "-"]);
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_darwin_arm64.tar.gz", "extract", "engram"), ["-xOzf", "-", "engram"]);
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_windows_amd64.zip", "list"), ["-tf", "-"]);
	assert.deepEqual(archiveReaderArgs("engram_2.1.0_windows_amd64.zip", "extract", "engram.exe"), ["-xOf", "-", "engram.exe"]);
	assert.throws(() => archiveReaderArgs("archive.tgz", "list"), /unsupported archive format/);
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

test("Windows verifies member bytes in memory without invoking a binary writer", async () => {
	assert.equal(typeof staging.deliverEngramMember, "function");
	const writes = [];
	const disposition = await staging.deliverEngramMember("win32", Buffer.from("verified member"), async (bytes) => writes.push(bytes));
	assert.equal(disposition, "memory-only");
	assert.deepEqual(writes, []);
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
