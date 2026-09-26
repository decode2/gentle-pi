import { inflateRawSync } from "node:zlib";

export const ZIP_INVENTORY_LIMITS = Object.freeze({
	maxArchiveBytes: 64 * 1024 * 1024,
	maxCentralDirectoryBytes: 1024 * 1024,
	maxEntries: 256,
	maxNameBytes: 1024,
	maxExtraBytes: 8192,
	maxCommentBytes: 4096,
	maxTotalUncompressedBytes: 128 * 1024 * 1024,
});

const DIAGNOSTIC = "ZIP inventory rejected";
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;

function reject() {
	throw new Error(DIAGNOSTIC);
}

function range(bytes, start, length, end = bytes.length) {
	if (!Number.isSafeInteger(start) || !Number.isSafeInteger(length) || start < 0 || length < 0 || start > end || length > end - start) reject();
}

function validateExtra(extra) {
	if (extra.length > ZIP_INVENTORY_LIMITS.maxExtraBytes) reject();
	if (extra.length === 0) return;
	if (extra.length !== 9 || extra.readUInt16LE(0) !== 0x5455 || extra.readUInt16LE(2) !== 5 || extra[4] !== 1) reject();
}

function validateFlags(method, flags) {
	if (method !== 0 && method !== 8) reject();
	const supported = (method === 8 ? 0x0806 : 0x0800) | 0x0008;
	if ((flags & ~supported) !== 0) reject();
}

function decodeName(bytes) {
	if (bytes.length === 0 || bytes.length > ZIP_INVENTORY_LIMITS.maxNameBytes) reject();
	// Refuse Unicode rather than approximate Windows filename equivalence.
	if (bytes.some((byte) => byte > 0x7f)) reject();
	let name;
	try {
		name = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		reject();
	}
	if (name.startsWith("/") || name.includes("\\") || name.includes("\uFEFF") || /[\u0000-\u001f\u007f<>:"|?*]/u.test(name)) reject();
	const segments = name.split("/");
	for (const segment of segments) {
		if (!segment || segment === "." || segment === ".." || /[. ]$/u.test(segment)) reject();
		const device = segment.split(".", 1)[0].toLowerCase();
		if (/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])$/u.test(device)) reject();
	}
	return name;
}

function validateType(host, attributes) {
	const dosAttributes = attributes & 0xff;
	if ((dosAttributes & 0x18) !== 0) reject();
	if (host === 3) {
		const unixMode = Math.floor(attributes / 0x10000) & 0xffff;
		if ((unixMode & 0xf000) !== 0x8000 || (unixMode & 0o7000) !== 0) reject();
	} else if (host === 0) {
		if (Math.floor(attributes / 0x10000) !== 0 || (dosAttributes & ~0x37) !== 0) reject();
	} else {
		reject();
	}
	return "regular";
}

function parse(bytes) {
	if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.length > ZIP_INVENTORY_LIMITS.maxArchiveBytes) reject();
	if (typeof SharedArrayBuffer !== "undefined" && bytes.buffer instanceof SharedArrayBuffer) reject();
	const lastCandidate = bytes.length - 22;
	const firstCandidate = Math.max(0, lastCandidate - ZIP_INVENTORY_LIMITS.maxCommentBytes);
	const candidates = [];
	for (let offset = firstCandidate; offset <= lastCandidate; offset++) {
		if (bytes.readUInt32LE(offset) !== EOCD_SIGNATURE) continue;
		const commentLength = bytes.readUInt16LE(offset + 20);
		if (commentLength <= ZIP_INVENTORY_LIMITS.maxCommentBytes && offset + 22 + commentLength === bytes.length) candidates.push(offset);
	}
	if (candidates.length !== 1) reject();

	const endOffset = candidates[0];
	const disk = bytes.readUInt16LE(endOffset + 4);
	const directoryDisk = bytes.readUInt16LE(endOffset + 6);
	const diskEntries = bytes.readUInt16LE(endOffset + 8);
	const entryCount = bytes.readUInt16LE(endOffset + 10);
	const directorySize = bytes.readUInt32LE(endOffset + 12);
	const directoryOffset = bytes.readUInt32LE(endOffset + 16);
	if (disk !== 0 || directoryDisk !== 0 || diskEntries !== entryCount || entryCount === 0xffff || directorySize === 0xffffffff || directoryOffset === 0xffffffff) reject();
	if (entryCount > ZIP_INVENTORY_LIMITS.maxEntries || directorySize > ZIP_INVENTORY_LIMITS.maxCentralDirectoryBytes) reject();
	if (directoryOffset > endOffset || directorySize !== endOffset - directoryOffset || entryCount * 46 > directorySize) reject();
	range(bytes, directoryOffset, directorySize, endOffset);

	const entries = [];
	const names = new Set();
	let cursor = directoryOffset;
	let totalUncompressed = 0;
	for (let index = 0; index < entryCount; index++) {
		range(bytes, cursor, 46, endOffset);
		if (bytes.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) reject();
		const host = bytes.readUInt16LE(cursor + 4) >>> 8;
		const flags = bytes.readUInt16LE(cursor + 8);
		const method = bytes.readUInt16LE(cursor + 10);
		const crc32 = bytes.readUInt32LE(cursor + 16);
		const compressedSize = bytes.readUInt32LE(cursor + 20);
		const uncompressedSize = bytes.readUInt32LE(cursor + 24);
		const nameLength = bytes.readUInt16LE(cursor + 28);
		const extraLength = bytes.readUInt16LE(cursor + 30);
		const commentLength = bytes.readUInt16LE(cursor + 32);
		const diskStart = bytes.readUInt16LE(cursor + 34);
		const attributes = bytes.readUInt32LE(cursor + 38);
		const localHeaderOffset = bytes.readUInt32LE(cursor + 42);
		const headerLength = 46 + nameLength + extraLength + commentLength;
		if (!nameLength || nameLength > ZIP_INVENTORY_LIMITS.maxNameBytes || extraLength > ZIP_INVENTORY_LIMITS.maxExtraBytes || commentLength > ZIP_INVENTORY_LIMITS.maxCommentBytes) reject();
		range(bytes, cursor, headerLength, endOffset);
		if (diskStart !== 0 || compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) reject();
		validateFlags(method, flags);
		if (method === 0 && compressedSize !== uncompressedSize) reject();
		const rawName = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
		const centralExtra = bytes.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength);
		validateExtra(centralExtra);
		const name = decodeName(rawName);
		const key = name.toLowerCase();
		if (names.has(key)) reject();
		names.add(key);
		const type = validateType(host, attributes);
		totalUncompressed += uncompressedSize;
		if (totalUncompressed > ZIP_INVENTORY_LIMITS.maxTotalUncompressedBytes) reject();
		entries.push({ name, rawName, rawExtra: centralExtra, method, flags, crc32, compressedSize, uncompressedSize, localHeaderOffset, type });
		cursor += headerLength;
	}
	if (cursor !== endOffset) reject();

	const localRanges = [];
	for (const entry of entries) {
		const offset = entry.localHeaderOffset;
		range(bytes, offset, 30, directoryOffset);
		if (bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE) reject();
		const flags = bytes.readUInt16LE(offset + 6);
		const method = bytes.readUInt16LE(offset + 8);
		const crc32 = bytes.readUInt32LE(offset + 14);
		const compressedSize = bytes.readUInt32LE(offset + 18);
		const uncompressedSize = bytes.readUInt32LE(offset + 22);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const extraLength = bytes.readUInt16LE(offset + 28);
		const hasDescriptor = (entry.flags & 8) !== 0;
		if (flags !== entry.flags || method !== entry.method) reject();
		if (hasDescriptor ? crc32 !== 0 || compressedSize !== 0 || uncompressedSize !== 0 : crc32 !== entry.crc32 || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) reject();
		if (nameLength !== entry.rawName.length || extraLength > ZIP_INVENTORY_LIMITS.maxExtraBytes) reject();
		const headerLength = 30 + nameLength + extraLength;
		range(bytes, offset, headerLength, directoryOffset);
		const localName = bytes.subarray(offset + 30, offset + 30 + nameLength);
		const localExtra = bytes.subarray(offset + 30 + nameLength, offset + headerLength);
		if (!localName.equals(entry.rawName)) reject();
		validateExtra(localExtra);
		if (!localExtra.equals(entry.rawExtra)) reject();
		const dataOffset = offset + headerLength;
		range(bytes, dataOffset, entry.compressedSize, directoryOffset);
		let end = dataOffset + entry.compressedSize;
		if (hasDescriptor) {
			range(bytes, end, 16, directoryOffset);
			if (bytes.readUInt32LE(end) !== 0x08074b50 || bytes.readUInt32LE(end + 4) !== entry.crc32 || bytes.readUInt32LE(end + 8) !== entry.compressedSize || bytes.readUInt32LE(end + 12) !== entry.uncompressedSize) reject();
			end += 16;
		}
		localRanges.push({ start: offset, end });
	}
	localRanges.sort((left, right) => left.start - right.start);
	let expectedOffset = 0;
	for (const localRange of localRanges) {
		if (localRange.start !== expectedOffset || localRange.end < localRange.start) reject();
		expectedOffset = localRange.end;
	}
	if (expectedOffset !== directoryOffset) reject();

	return Object.freeze(entries.map(({ rawName, rawExtra, ...entry }) => Object.freeze(entry)));
}

export function inventoryZip(bytes) {
	try {
		return parse(bytes);
	} catch {
		throw new Error(DIAGNOSTIC);
	}
}

export const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const EXTRACTION_DIAGNOSTIC = "ZIP extraction rejected";
const CRC32_TABLE = new Uint32Array(256);
for (let index = 0; index < CRC32_TABLE.length; index++) {
	let value = index;
	for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
	CRC32_TABLE[index] = value >>> 0;
}

function crc32(bytes) {
	let value = 0xffffffff;
	for (const byte of bytes) value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
	return (value ^ 0xffffffff) >>> 0;
}

function rejectExtraction() {
	throw new Error(EXTRACTION_DIAGNOSTIC);
}

export function extractZipMember(bytes, expectedName) {
	try {
		if (typeof expectedName !== "string" || expectedName.length === 0 || expectedName.length > ZIP_INVENTORY_LIMITS.maxNameBytes || /[^\x00-\x7f]/u.test(expectedName)) rejectExtraction();
		const inventory = inventoryZip(bytes);
		const matches = inventory.filter((entry) => entry.name === expectedName && entry.type === "regular");
		if (matches.length !== 1) rejectExtraction();
		const entry = matches[0];
		if (entry.compressedSize > MAX_BINARY_BYTES || entry.uncompressedSize > MAX_BINARY_BYTES || entry.uncompressedSize === 0) rejectExtraction();

		const offset = entry.localHeaderOffset;
		range(bytes, offset, 30);
		if (bytes.readUInt32LE(offset) !== LOCAL_SIGNATURE) rejectExtraction();
		const flags = bytes.readUInt16LE(offset + 6);
		const method = bytes.readUInt16LE(offset + 8);
		const crc = bytes.readUInt32LE(offset + 14);
		const compressedSize = bytes.readUInt32LE(offset + 18);
		const uncompressedSize = bytes.readUInt32LE(offset + 22);
		const nameLength = bytes.readUInt16LE(offset + 26);
		const extraLength = bytes.readUInt16LE(offset + 28);
		const nameBytes = Buffer.from(expectedName, "ascii");
		const hasDescriptor = (entry.flags & 8) !== 0;
		if (flags !== entry.flags || method !== entry.method || nameLength !== nameBytes.length) rejectExtraction();
		if (hasDescriptor ? crc !== 0 || compressedSize !== 0 || uncompressedSize !== 0 : crc !== entry.crc32 || compressedSize !== entry.compressedSize || uncompressedSize !== entry.uncompressedSize) rejectExtraction();
		if (extraLength > ZIP_INVENTORY_LIMITS.maxExtraBytes) rejectExtraction();
		const payloadOffset = offset + 30 + nameLength + extraLength;
		range(bytes, offset + 30, nameLength + extraLength);
		if (!bytes.subarray(offset + 30, offset + 30 + nameLength).equals(nameBytes)) rejectExtraction();
		validateExtra(bytes.subarray(offset + 30 + nameLength, payloadOffset));
		range(bytes, payloadOffset, entry.compressedSize);
		const compressed = bytes.subarray(payloadOffset, payloadOffset + entry.compressedSize);
		let output;
		if (method === 0) {
			if (compressedSize !== uncompressedSize) rejectExtraction();
			output = Buffer.from(compressed);
		} else if (method === 8) {
			output = inflateRawSync(compressed, { maxOutputLength: MAX_BINARY_BYTES });
		} else {
			rejectExtraction();
		}
		if (output.length === 0 || output.length !== entry.uncompressedSize || output.length > MAX_BINARY_BYTES || crc32(output) !== entry.crc32) rejectExtraction();
		return output;
	} catch {
		throw new Error(EXTRACTION_DIAGNOSTIC);
	}
}
