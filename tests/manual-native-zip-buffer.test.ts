import assert from "node:assert/strict";
import test from "node:test";
import * as zipModule from "../scripts/manual-native-zip-buffer.mjs";
import { deflateRawSync } from "node:zlib";

const { inventoryZip, ZIP_INVENTORY_LIMITS } = zipModule;
const DIAGNOSTIC = "ZIP inventory rejected";
const EXTRACTION_DIAGNOSTIC = "ZIP extraction rejected";
const MAX_BINARY_BYTES = 32 * 1024 * 1024;

function zip(entries = [], { comment = Buffer.alloc(0), disk = 0 } = {}) {
	const locals = [];
	const central = [];
	const centralPositions = [];
	let localOffset = 0;
	for (const entry of entries) {
		const name = entry.nameBytes ?? Buffer.from(entry.name ?? "file.txt", "utf8");
		const data = entry.data ?? Buffer.alloc(0);
		const extra = entry.extra ?? Buffer.alloc(0);
		const localExtra = entry.localExtra ?? extra;
		const method = entry.method ?? 0;
		const flags = entry.flags ?? 0;
		const crc = entry.crc ?? 0x12345678;
		const compressed = entry.compressedSize ?? data.length;
		const uncompressed = entry.uncompressedSize ?? data.length;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(entry.localFlags ?? flags, 6);
		local.writeUInt16LE(entry.localMethod ?? method, 8);
		local.writeUInt32LE(entry.localCrc ?? crc, 14);
		local.writeUInt32LE(entry.localCompressedSize ?? compressed, 18);
		local.writeUInt32LE(entry.localUncompressedSize ?? uncompressed, 22);
		local.writeUInt16LE(entry.localNameBytes?.length ?? name.length, 26);
		local.writeUInt16LE(localExtra.length, 28);
		locals.push(Buffer.concat([local, entry.localNameBytes ?? name, localExtra, data]));

		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE(((entry.host ?? 3) << 8) | 20, 4);
		header.writeUInt16LE(flags, 8);
		header.writeUInt16LE(method, 10);
		header.writeUInt32LE(crc, 16);
		header.writeUInt32LE(compressed, 20);
		header.writeUInt32LE(uncompressed, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt16LE(extra.length, 30);
		header.writeUInt16LE(entry.memberComment?.length ?? 0, 32);
		header.writeUInt16LE(entry.disk ?? 0, 34);
		header.writeUInt32LE(entry.externalAttributes ?? (0o100644 * 0x10000) >>> 0, 38);
		header.writeUInt32LE(entry.centralLocalOffset ?? localOffset, 42);
		centralPositions.push(locals.reduce((sum, part) => sum + part.length, 0) + central.reduce((sum, part) => sum + part.length, 0));
		central.push(Buffer.concat([header, name, extra, entry.memberComment ?? Buffer.alloc(0)]));
		localOffset += locals.at(-1).length;
	}
	const localBytes = Buffer.concat(locals);
	const centralBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(disk, 4);
	end.writeUInt16LE(disk, 6);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(localBytes.length, 16);
	end.writeUInt16LE(comment.length, 20);
	return { bytes: Buffer.concat([localBytes, centralBytes, end, comment]), centralPositions };
}

function rejected(bytes) {
	assert.throws(() => inventoryZip(bytes), (error) => error.message === DIAGNOSTIC);
}

function crc32(bytes) {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function extractionRejected(bytes, name) {
	assert.throws(() => zipModule.extractZipMember(bytes, name), (error) => error instanceof Error && error.message === EXTRACTION_DIAGNOSTIC);
}

test("inventories stored and deflate entries as frozen metadata only", () => {
	const { bytes } = zip([
		{ name: "tools/helper.sh", data: Buffer.from("x"), crc: 7 },
		{ name: "engram", method: 8, data: Buffer.from([3, 0]), crc: 0, uncompressedSize: 0 },
	]);
	const inventory = inventoryZip(bytes);
	assert.equal(Object.isFrozen(inventory), true);
	assert.deepEqual(inventory.map((entry) => entry.name), ["tools/helper.sh", "engram"]);
	assert.deepEqual(inventory.map((entry) => entry.method), [0, 8]);
	assert.deepEqual(Object.keys(inventory[0]), ["name", "method", "flags", "crc32", "compressedSize", "uncompressedSize", "localHeaderOffset", "type"]);
	assert.equal(inventory[0].flags, 0);
	assert.equal(inventory[0].crc32, 7);
	assert.equal(inventory[1].compressedSize, 2);
	assert.equal(inventory[1].uncompressedSize, 0);
	assert.equal(inventory[0].type, "regular");
	assert.equal(inventory[0].localHeaderOffset, 0);
	assert.equal(Object.isFrozen(inventory[0]), true);
	assert.equal("bytes" in inventory[0], false);
	const shared = new SharedArrayBuffer(bytes.length);
	const sharedBytes = Buffer.from(shared);
	bytes.copy(sharedBytes);
	rejected(sharedBytes);
});

test("rejects malformed, truncated, trailing, and ambiguous EOCD layouts", () => {
	const valid = zip([]).bytes;
	rejected(valid.subarray(0, valid.length - 1));
	rejected(Buffer.concat([valid, Buffer.from([0])]));
	const ambiguous = Buffer.concat([valid, Buffer.alloc(22)]);
	ambiguous.writeUInt16LE(22, valid.length - 2);
	ambiguous.writeUInt32LE(0x06054b50, valid.length);
	rejected(ambiguous);
	const brokenCentral = zip([{ name: "x" }]);
	brokenCentral.bytes.writeUInt32LE(0, brokenCentral.centralPositions[0]);
	rejected(brokenCentral.bytes);
});

test("rejects multi-disk, ZIP64, out-of-range, and overlapping records", () => {
	const multiDisk = zip([]).bytes;
	multiDisk.writeUInt16LE(1, multiDisk.length - 18);
	rejected(multiDisk);
	const zip64 = zip([]).bytes;
	zip64.writeUInt32LE(0xffffffff, zip64.length - 10);
	rejected(zip64);
	const outsideDirectory = zip([]).bytes;
	outsideDirectory.writeUInt32LE(1, outsideDirectory.length - 6);
	rejected(outsideDirectory);
	const outsideLocal = zip([{ name: "x" }]);
	outsideLocal.bytes.writeUInt32LE(0xfffffff0, outsideLocal.centralPositions[0] + 42);
	rejected(outsideLocal.bytes);
	const overlap = zip([{ name: "a" }, { name: "b" }]);
	overlap.bytes.writeUInt32LE(0, overlap.centralPositions[1] + 42);
	rejected(overlap.bytes);
});

test("rejects encryption, descriptors, unsupported flags, methods, and mismatched local headers", () => {
	for (const entry of [{ flags: 1 }, { flags: 8 }, { flags: 0x40 }, { method: 12 }]) rejected(zip([entry]).bytes);
	for (const entry of [{ localFlags: 1 }, { localMethod: 8 }, { localCrc: 9 }, { localNameBytes: Buffer.from("other") }]) rejected(zip([{ name: "file.txt", ...entry }]).bytes);
	rejected(zip([{ name: "stored-size-mismatch", uncompressedSize: 1 }]).bytes);
	rejected(zip([{ name: "outside-data", method: 8, compressedSize: 64, uncompressedSize: 0 }]).bytes);
	rejected(zip([{ name: "other-disk", disk: 1 }]).bytes);
});

test("rejects unsafe, duplicate, invalid UTF-8, and oversized member names", () => {
	for (const name of ["../escape", "/absolute", "C:/drive", "a\\b", "a//b", "a/../b", "dir/", "NUL.txt", "COM¹", "LPT².bin", "CONIN$", "a:stream", "a."]) {
		rejected(zip([{ name }]).bytes);
	}
	rejected(zip([{ name: "same" }, { name: "same" }]).bytes);
	rejected(zip([{ name: "same" }, { name: "SAME" }]).bytes);
	rejected(zip([{ name: "café", flags: 0x0800 }, { name: "cafe\u0301", flags: 0x0800 }]).bytes);
	rejected(zip([{ nameBytes: Buffer.from([0xc3, 0x28]), flags: 0x0800 }]).bytes);
	rejected(zip([{ name: "café" }]).bytes);
	rejected(zip([{ name: "café", flags: 0x0800 }]).bytes);
	rejected(zip([{ name: "n".repeat(ZIP_INVENTORY_LIMITS.maxNameBytes + 1) }]).bytes);
});

test("rejects Unicode Windows case-collision aliases", () => {
	rejected(zip([{ name: "s", flags: 0x0800 }, { name: "ſ", flags: 0x0800 }]).bytes);
});

test("rejects directory, symlink, special-file, and unsupported host metadata", () => {
	for (const entry of [
		{ name: "directory", externalAttributes: (0o040755 * 0x10000) >>> 0 },
		{ name: "link", externalAttributes: (0o120777 * 0x10000) >>> 0 },
		{ name: "fifo", externalAttributes: (0o010644 * 0x10000) >>> 0 },
		{ name: "directory", host: 0, externalAttributes: 0x10 },
		{ name: "file", host: 10 },
	]) rejected(zip([entry]).bytes);
});

test("rejects malformed or ZIP64 extra fields and configured resource overages", () => {
	const malformedExtra = Buffer.from([1, 0, 4, 0, 9]);
	rejected(zip([{ name: "x", extra: malformedExtra }]).bytes);
	const zip64Extra = Buffer.from([1, 0, 0, 0]);
	rejected(zip([{ name: "x", extra: zip64Extra }]).bytes);
	rejected(zip([{ name: "x", extra: Buffer.alloc(ZIP_INVENTORY_LIMITS.maxExtraBytes + 1) }]).bytes);
	rejected(zip([{ name: "x", memberComment: Buffer.alloc(ZIP_INVENTORY_LIMITS.maxCommentBytes + 1) }]).bytes);
	rejected(zip([], { comment: Buffer.alloc(ZIP_INVENTORY_LIMITS.maxCommentBytes + 1) }).bytes);
	rejected(zip(Array.from({ length: ZIP_INVENTORY_LIMITS.maxEntries + 1 }, (_, index) => ({ name: `f${index}` }))).bytes);
	const largeDirectory = Array.from({ length: ZIP_INVENTORY_LIMITS.maxEntries }, (_, index) => ({ name: `f${index}`, memberComment: Buffer.alloc(ZIP_INVENTORY_LIMITS.maxCommentBytes) }));
	rejected(zip(largeDirectory).bytes);
	rejected(zip([
		{ name: "a", uncompressedSize: ZIP_INVENTORY_LIMITS.maxTotalUncompressedBytes },
		{ name: "b", uncompressedSize: 1 },
	]).bytes);
	rejected(Buffer.alloc(ZIP_INVENTORY_LIMITS.maxArchiveBytes + 1));
});

test("rejects local-area gaps and unsupported extra metadata", () => {
	const contiguous = zip([{ name: "x" }]);
	const directoryStart = contiguous.centralPositions[0];
	const gap = Buffer.concat([contiguous.bytes.subarray(0, directoryStart), Buffer.from([0]), contiguous.bytes.subarray(directoryStart)]);
	gap.writeUInt32LE(directoryStart + 1, gap.length - 6);
	rejected(gap);
	rejected(zip([{ name: "x", extra: Buffer.from([0x55, 0x54, 0, 0]) }]).bytes);
	rejected(zip([{ name: "x", localExtra: Buffer.from([0x55, 0x54, 0, 0]) }]).bytes);
	rejected(zip([{ name: "x", localExtra: Buffer.alloc(ZIP_INVENTORY_LIMITS.maxExtraBytes + 1) }]).bytes);
});

test("public failures never echo hostile names, bytes, or underlying metadata", () => {
	const sentinel = "SECRET_MEMBER_PATH_SENTINEL";
	assert.throws(() => inventoryZip(zip([{ name: `../${sentinel}` }]).bytes), (error) => {
		assert.equal(error.message, DIAGNOSTIC);
		assert.equal(error.message.includes(sentinel), false);
		return true;
	});
	assert.throws(() => inventoryZip("RAW_ARCHIVE_SENTINEL"), (error) => error.message === DIAGNOSTIC);
});

test("extracts exact stored and deflated members into fresh buffers", () => {
	const storedBytes = Buffer.from("stored native bytes");
	const storedArchive = zip([{ name: "engram.exe", data: storedBytes, crc: crc32(storedBytes) }]).bytes;
	const before = Buffer.from(storedArchive);
	const stored = zipModule.extractZipMember(storedArchive, "engram.exe");
	assert.equal(Buffer.isBuffer(stored), true);
	assert.deepEqual(stored, storedBytes);
	assert.notStrictEqual(stored, storedBytes);
	stored[0] ^= 0xff;
	assert.deepEqual(storedArchive, before);

	const deflatedBytes = Buffer.from("deflated native bytes");
	const deflatedArchive = zip([{ name: "engram.exe", method: 8, data: deflateRawSync(deflatedBytes), uncompressedSize: deflatedBytes.length, crc: crc32(deflatedBytes) }]).bytes;
	assert.deepEqual(zipModule.extractZipMember(deflatedArchive, "engram.exe"), deflatedBytes);
	assert.equal(zipModule.MAX_BINARY_BYTES, MAX_BINARY_BYTES);
});

test("rejects extraction CRC/size corruption, overrun, mismatched headers, and unsupported methods", () => {
	const bytes = Buffer.from("payload");
	extractionRejected(zip([{ name: "engram.exe", data: bytes, crc: crc32(bytes) ^ 1 }]).bytes, "engram.exe");
	const wrongLength = deflateRawSync(bytes);
	extractionRejected(zip([{ name: "engram.exe", method: 8, data: wrongLength, uncompressedSize: bytes.length + 1, crc: crc32(bytes) }]).bytes, "engram.exe");

	const overrun = deflateRawSync(Buffer.alloc(MAX_BINARY_BYTES + 1));
	extractionRejected(zip([{ name: "engram.exe", method: 8, data: overrun, uncompressedSize: MAX_BINARY_BYTES, crc: 0 }]).bytes, "engram.exe");
	extractionRejected(zip([{ name: "engram.exe", data: bytes, crc: crc32(bytes), localCrc: 0 }]).bytes, "engram.exe");
	extractionRejected(zip([{ name: "engram.exe", method: 12, data: bytes }]).bytes, "engram.exe");
	extractionRejected(zip([{ name: "engram.exe", method: 8, data: Buffer.from([0xff]), uncompressedSize: bytes.length }]).bytes, "engram.exe");
	extractionRejected(zip([{ name: "engram.exe", data: Buffer.alloc(0), crc: 0 }]).bytes, "engram.exe");
});

test("requires one exact expected member and sanitizes hostile extraction failures", () => {
	const bytes = Buffer.from("binary");
	const archive = zip([{ name: "engram.exe", data: bytes, crc: crc32(bytes) }]).bytes;
	extractionRejected(archive, "other.exe");
	extractionRejected(archive, "../SECRET_MEMBER_PATH_SENTINEL");
	extractionRejected(archive.subarray(0, archive.length - 1), "engram.exe");
	const corrupt = zip([{ name: "engram.exe", method: 8, data: Buffer.from([0xff]), uncompressedSize: 5 }]).bytes;
	assert.throws(() => zipModule.extractZipMember(corrupt, "engram.exe"), (error) => {
		assert.equal(error.message, EXTRACTION_DIAGNOSTIC);
		assert.equal(error.message.includes("SECRET_MEMBER_PATH_SENTINEL"), false);
		assert.equal(error.message.includes("invalid block type"), false);
		return true;
	});
});
