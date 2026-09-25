import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join, parse, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveEngramReleaseAsset, resolveScratchDirectory } from "./manual-native-preflight.mjs";
import { inventoryZip } from "./manual-native-zip-buffer.mjs";

export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_SCRIPT_MEMBER_BYTES = 64 * 1024;
export const MAX_EXECUTABLE_MEMBER_BYTES = 32 * 1024 * 1024;
export const ZIP_PROBE_SUCCESS = "official-zip-inventory-valid";

const EXPECTED_MEMBERS = Object.freeze({
	"win32/x64": Object.freeze([
		Object.freeze({ name: "tools/cloud-sync-projects.ps1", maxBytes: MAX_SCRIPT_MEMBER_BYTES }),
		Object.freeze({ name: "tools/cloud-sync-projects.sh", maxBytes: MAX_SCRIPT_MEMBER_BYTES }),
		Object.freeze({ name: "engram.exe", maxBytes: MAX_EXECUTABLE_MEMBER_BYTES }),
	]),
	"win32/arm64": Object.freeze([
		Object.freeze({ name: "tools/cloud-sync-projects.ps1", maxBytes: MAX_SCRIPT_MEMBER_BYTES }),
		Object.freeze({ name: "tools/cloud-sync-projects.sh", maxBytes: MAX_SCRIPT_MEMBER_BYTES }),
		Object.freeze({ name: "engram.exe", maxBytes: MAX_EXECUTABLE_MEMBER_BYTES }),
	]),
});
const FAILURE_CODES = Object.freeze([
	"official-zip-archive-read-failed",
	"official-zip-digest-mismatch",
	"official-zip-compatibility-unknown",
	"official-zip-manifest-rejected",
	"official-zip-unsupported-platform",
	"unknown",
]);
const allowedFailureCodes = new Set(FAILURE_CODES);
const failureBrands = new WeakMap();
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function codedFailure(code) {
	const error = new Error("official ZIP inventory probe failed");
	failureBrands.set(error, allowedFailureCodes.has(code) ? code : "unknown");
	return error;
}

function fail(code) {
	throw codedFailure(code);
}

export function safeFailureCode(error) {
	if ((typeof error !== "object" || error === null) && typeof error !== "function") return "unknown";
	const code = failureBrands.get(error);
	return allowedFailureCodes.has(code) ? code : "unknown";
}

export function validateOfficialZipBuffer(bytes, asset, platform, architecture) {
	try {
		const expected = EXPECTED_MEMBERS[`${platform}/${architecture}`];
		if (!expected) fail("official-zip-unsupported-platform");
		if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARCHIVE_BYTES) fail("official-zip-compatibility-unknown");
		if (typeof asset?.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256) || sha256(bytes) !== asset.sha256) fail("official-zip-digest-mismatch");

		let inventory;
		try { inventory = inventoryZip(bytes); } catch { fail("official-zip-compatibility-unknown"); }
		if (inventory.length !== expected.length) fail("official-zip-manifest-rejected");
		const actualNames = new Set(inventory.map((entry) => entry.name));
		if (actualNames.size !== expected.length || expected.some((member) => !actualNames.has(member.name))) fail("official-zip-manifest-rejected");
		for (const member of expected) {
			const entry = inventory.find((candidate) => candidate.name === member.name);
			if (entry?.type !== "regular" || !Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize <= 0 || entry.uncompressedSize > member.maxBytes) fail("official-zip-manifest-rejected");
		}
		return ZIP_PROBE_SUCCESS;
	} catch (error) {
		if (failureBrands.has(error)) throw error;
		fail("unknown");
	}
}

async function assertRealDirectoryChain(directory) {
	const absolute = resolve(directory);
	const root = parse(absolute).root;
	let current = root;
	const inspect = async (path) => {
		const details = await lstat(path);
		if (!details.isDirectory() || details.isSymbolicLink()) throw new Error("unsafe directory");
	};
	await inspect(current);
	for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
		current = join(current, part);
		await inspect(current);
	}
}

function sameFile(left, right) {
	return left.isFile() && right.isFile() && !left.isSymbolicLink() && !right.isSymbolicLink()
		&& left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

async function readBoundedArchive(path, maxBytes) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0 || maxBytes > MAX_ARCHIVE_BYTES) throw new Error("invalid archive bound");
	await assertRealDirectoryChain(dirname(path));
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxBytes) throw new Error("unsafe archive leaf");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!sameFile(before, opened)) throw new Error("archive changed");
		const chunks = [];
		let total = 0;
		while (total <= maxBytes) {
			const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
			const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
			if (bytesRead === 0) break;
			total += bytesRead;
			if (total > maxBytes) throw new Error("archive exceeds bound");
			chunks.push(chunk.subarray(0, bytesRead));
		}
		const after = await handle.stat();
		if (total !== opened.size || !sameFile(opened, after)) throw new Error("archive changed while reading");
		await assertRealDirectoryChain(dirname(path));
		const leaf = await lstat(path);
		if (!sameFile(opened, leaf)) throw new Error("archive leaf changed");
		return Buffer.concat(chunks, total);
	} finally {
		await handle.close();
	}
}

export async function inspectStagedOfficialZip({
	runnerTemp,
	platform = process.platform,
	architecture = process.arch,
	readArchive = readBoundedArchive,
} = {}) {
	if (platform !== "win32") fail("official-zip-unsupported-platform");
	let asset;
	let archivePath;
	try {
		asset = resolveEngramReleaseAsset(platform, architecture);
		archivePath = join(resolveScratchDirectory(runnerTemp), asset.name);
	} catch {
		fail("official-zip-archive-read-failed");
	}
	let bytes;
	try { bytes = await readArchive(archivePath, MAX_ARCHIVE_BYTES); } catch { fail("official-zip-archive-read-failed"); }
	return validateOfficialZipBuffer(bytes, asset, platform, architecture);
}

async function runCli(args) {
	if (args.length !== 0) fail("unknown");
	const result = await inspectStagedOfficialZip({ runnerTemp: process.env.RUNNER_TEMP, platform: process.platform, architecture: process.arch });
	console.log(result);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runCli(process.argv.slice(2)).catch((error) => {
		console.error(safeFailureCode(error));
		process.exitCode = 1;
	});
}
