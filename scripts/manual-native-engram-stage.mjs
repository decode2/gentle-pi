import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { ENGRAM_VERSION, resolveEngramReleaseAsset, resolveScratchDirectory } from "./manual-native-preflight.mjs";
import { extractZipMember } from "./manual-native-zip-buffer.mjs";
import { validateOfficialZipBuffer } from "./manual-native-zip-official-probe.mjs";

export const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
export const MAX_BINARY_BYTES = 32 * 1024 * 1024;
const MANIFESTS = Object.freeze({
	"darwin/x64": ["tools/cloud-sync-projects.ps1", "tools/cloud-sync-projects.sh", "engram"],
	"darwin/arm64": ["tools/cloud-sync-projects.ps1", "tools/cloud-sync-projects.sh", "engram"],
	"win32/x64": ["tools/cloud-sync-projects.ps1", "tools/cloud-sync-projects.sh", "engram.exe"],
	"win32/arm64": ["tools/cloud-sync-projects.ps1", "tools/cloud-sync-projects.sh", "engram.exe"],
});
const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const READER_CONDITIONS = ["executable", "cwd", "spawn", "exit", "zero-output"];
const READER_OPERATIONS = new Map(["list", "verbose", "extract"].map((operation) => [operation, READER_CONDITIONS.map((condition) => `native-reader-${operation}-${condition}`)]));
const READER_FAILURES = [...READER_OPERATIONS.values()].flat();
const LIST_OUTPUT_FAILURES = ["native-reader-list-invalid-utf8", "native-reader-list-empty-output", "native-reader-list-newline", "native-reader-list-malformed-output"];
const VERBOSE_OUTPUT_FAILURES = ["native-reader-verbose-invalid-utf8", "native-reader-verbose-empty-output", "native-reader-verbose-newline", "native-reader-verbose-malformed-output"];
const FAILURE_REASONS = new Set(["archive-read", "archive-digest", "zip-validation", "zip-extraction", "native-reader-invocation", "native-reader-list", "native-reader-manifest", "native-reader-verbose", "native-reader-extract", ...READER_FAILURES, ...LIST_OUTPUT_FAILURES, ...VERBOSE_OUTPUT_FAILURES, "darwin-private-root", "darwin-write", "darwin-readback"]);
const NESTED_FAILURES = new Map([
	["native-reader-list", ["native-reader-invocation", ...READER_OPERATIONS.get("list"), ...LIST_OUTPUT_FAILURES]],
	["native-reader-verbose", ["native-reader-invocation", ...READER_OPERATIONS.get("verbose"), ...VERBOSE_OUTPUT_FAILURES]],
	["native-reader-extract", [
		"native-reader-invocation", "native-reader-list", ...READER_OPERATIONS.get("list"), ...LIST_OUTPUT_FAILURES,
		"native-reader-verbose", ...READER_OPERATIONS.get("verbose"), ...VERBOSE_OUTPUT_FAILURES, "native-reader-manifest",
		...READER_OPERATIONS.get("extract"), "zip-validation", "zip-extraction", "darwin-private-root", "darwin-write", "darwin-readback",
	]]]);
const failureBrand = new WeakMap();
function brandedFailure(reason) { const error = new Error("member validation failed"); if (FAILURE_REASONS.has(reason)) failureBrand.set(error, reason); return error; }
function readerFailure(operation, condition) {
	const reason = READER_OPERATIONS.get(operation)?.find((candidate) => candidate === `native-reader-${operation}-${condition}`);
	return reason ? brandedFailure(reason) : new Error("member validation failed");
}
export async function withFailureReason(reason, operation) {
	try { return await operation(); } catch (error) {
		if (NESTED_FAILURES.has(reason)) {
			const nested = failureBrand.get(error);
			if (!nested && reason !== "native-reader-extract") throw error;
			if (nested && NESTED_FAILURES.get(reason).includes(nested)) throw error;
		}
		throw brandedFailure(reason);
	}
}
export function safeFailureCode(error) { const reason = failureBrand.get(error); return FAILURE_REASONS.has(reason) ? `member-validation-${reason}` : "unknown"; }

export function assertSafeArchiveName(name) {
	if (typeof name !== "string" || !name || /[\0-\x1f\x7f\\]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name)) fail("unsafe archive member");
	const parts = name.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) fail("unsafe archive member");
	return true;
}

export function archiveReaderArgs(archiveName, operation, memberName) {
	if (!archiveName.endsWith(".tar.gz")) fail("unsupported archive format");
	if (operation === "list") return ["-tzf", "-"];
	if (operation === "verbose") return ["-tvzf", "-"];
	if (operation === "extract") {
		assertSafeArchiveName(memberName);
		return ["-xOzf", "-", memberName];
	}
	fail("invalid archive reader operation");
}

export function selectEngramMember(entries, memberName) {
	assertSafeArchiveName(memberName);
	if (!Array.isArray(entries) || !entries.length) fail("invalid archive manifest");
	const names = new Set();
	for (const entry of entries) {
		assertSafeArchiveName(entry?.name);
		if (names.has(entry.name)) fail("duplicate archive member");
		names.add(entry.name);
		if (entry.type !== "file") fail("non-regular archive member");
		if (entry.size !== undefined && (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_BINARY_BYTES)) fail("oversized archive member");
	}
	const matches = entries.filter((entry) => entry.name === memberName);
	if (matches.length !== 1) fail("missing archive member");
	return matches[0];
}

export async function assertRealDirectoryChain(directory, inspect = lstat, platform = process.platform) {
	const pathApi = platform === "win32" ? win32 : null;
	const absolute = pathApi ? pathApi.resolve(directory) : resolve(directory);
	const root = pathApi ? pathApi.parse(absolute).root : parse(absolute).root;
	if (!isAbsolute(absolute)) fail("unsafe scratch directory or symlink ancestor");
	let current = root;
	const parts = pathApi ? absolute.slice(root.length).split(/[\\/]/).filter(Boolean) : absolute.slice(root.length).split(sep).filter(Boolean);
	for (const part of parts) {
		current = pathApi ? pathApi.join(current, part) : join(current, part);
		let details;
		try { details = await inspect(current); } catch { fail("unsafe scratch directory or symlink ancestor"); }
		if (!details.isDirectory() || details.isSymbolicLink()) fail("unsafe scratch directory or symlink ancestor");
	}
}

export function assertRegularLeaf(details, maxBytes) {
	if (!details?.isFile() || details.isSymbolicLink()) fail("unsafe staged binary leaf");
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || details.size > maxBytes) fail("oversized staged artifact");
	return true;
}

export function exclusiveBinaryWriteFlags() {
	return constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0);
}

export async function deliverEngramMember(platform, bytes, stageDarwin) {
	if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BINARY_BYTES) fail("oversized binary");
	if (platform === "win32") return "member-validation-memory-only";
	if (platform !== "darwin" || typeof stageDarwin !== "function") fail("unsupported staging platform");
	await stageDarwin(bytes);
	return "staged";
}

export function assertBinaryIdentity(extracted, staged) {
	if (!(extracted instanceof Uint8Array) || !(staged instanceof Uint8Array) || !extracted.length || extracted.length > MAX_BINARY_BYTES || staged.length > MAX_BINARY_BYTES) fail("oversized binary");
	if (extracted.length !== staged.length || sha256(extracted) !== sha256(staged)) fail("binary identity mismatch");
	return true;
}

function resolveStageLayout(runnerTemp) {
	const preflight = resolveScratchDirectory(runnerTemp);
	const root = join(dirname(preflight), "gentle-shell-manual-native-engram");
	return { runnerTemp: resolve(runnerTemp), preflight, root, bin: join(root, "bin") };
}

async function assertPrivateDirectory(path) {
	const details = await lstat(path);
	if (!details.isDirectory() || details.isSymbolicLink() || (details.mode & 0o077) !== 0) fail("unsafe private scratch directory");
	if (typeof process.getuid === "function" && details.uid !== process.getuid()) fail("scratch directory owner mismatch");
}

async function prepareBin(layout) {
	await assertRealDirectoryChain(layout.runnerTemp);
	await assertRealDirectoryChain(layout.preflight);
	await mkdir(layout.root, { mode: 0o700 });
	await assertPrivateDirectory(layout.root);
	await mkdir(layout.bin, { mode: 0o700 });
	await assertPrivateDirectory(layout.bin);
}

async function readBoundedRegularFile(path, allowedRoot, maxBytes) {
	const root = resolve(allowedRoot), target = resolve(path), rel = process.platform === "win32" ? win32.relative(root, target) : relative(root, target);
	if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) fail("unsafe staged artifact path");
	await assertRealDirectoryChain(root);
	await assertRealDirectoryChain(dirname(target));
	let before;
	try { before = await lstat(target); } catch { fail("unsafe staged artifact"); }
	assertRegularLeaf(before, maxBytes);
	let handle;
	try { handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); } catch { fail("unsafe staged artifact"); }
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail("staged artifact changed while opening");
		const chunks = [];
		let total = 0;
		while (total <= maxBytes) {
			const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > maxBytes) fail("oversized staged artifact");
			chunks.push(buffer.subarray(0, bytesRead));
		}
		const after = await handle.stat();
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("staged artifact changed while reading");
		await assertRealDirectoryChain(dirname(target));
		const leaf = await lstat(target);
		if (!leaf.isFile() || leaf.isSymbolicLink() || leaf.dev !== opened.dev || leaf.ino !== opened.ino) fail("unsafe staged artifact");
		return Buffer.concat(chunks, total);
	} finally { await handle.close(); }
}

function tarExecutable(platform, environment = process.env) {
	if (platform === "darwin") return "/usr/bin/tar";
	if (platform === "win32") {
		const root = environment.SystemRoot ?? environment.WINDIR;
		if (!root || !win32.isAbsolute(root)) fail("native archive reader unavailable");
		return win32.join(root, "System32", "tar.exe");
	}
	fail("unsupported native platform");
}

async function checkReaderExecutable(platform, environment) {
	const executable = tarExecutable(platform, environment);
	await assertRealDirectoryChain(dirname(executable));
	const reader = await lstat(executable);
	if (!reader.isFile() || reader.isSymbolicLink()) fail("native archive reader unavailable");
	return executable;
}

export async function runNativeReader(bytes, args, cwd, maxOutput, dependencies = {}) {
	const operation = dependencies.operation;
	if (!READER_OPERATIONS.has(operation)) throw new Error("invalid native reader operation");
	const platform = dependencies.platform ?? process.platform;
	const environment = dependencies.environment ?? process.env;
	let executable;
	try {
		executable = await (dependencies.checkExecutable ?? (() => checkReaderExecutable(platform, environment)))();
		if (typeof executable !== "string" || !executable) fail("native archive reader unavailable");
	} catch { throw readerFailure(operation, "executable"); }
	try { await (dependencies.checkCwd ?? assertRealDirectoryChain)(cwd); } catch { throw readerFailure(operation, "cwd"); }
	const env = platform === "win32"
		? { SystemRoot: environment.SystemRoot ?? environment.WINDIR }
		: { PATH: "/usr/bin:/bin", LC_ALL: "C" };
	let result;
	try {
		result = (dependencies.spawnSync ?? spawnSync)(executable, args, {
			cwd, env, input: bytes, maxBuffer: maxOutput, windowsHide: true, encoding: null, stdio: ["pipe", "pipe", "ignore"],
		});
	} catch { throw readerFailure(operation, "spawn"); }
	if (result?.error) throw readerFailure(operation, "spawn");
	if (result?.status !== 0) throw readerFailure(operation, "exit");
	if (!(result.stdout instanceof Uint8Array) || result.stdout.byteLength === 0) throw readerFailure(operation, "zero-output");
	return result.stdout;
}

export function parseReaderOutput(bytes, phase) {
	if (phase !== "list" && phase !== "verbose") fail("invalid reader output phase");
	const failure = (kind) => { throw brandedFailure(`native-reader-${phase}-${kind}`); };
	if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) failure("empty-output");
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { failure("invalid-utf8"); }
	if (!text.endsWith("\n")) failure("newline");
	const lines = text.slice(0, -1).split(/\r?\n/);
	if (lines.some((line) => !line)) failure("empty-output");
	if (lines.some((line) => /[\0-\x08\x0b\x0c\x0e-\x1f\x7f\r]/.test(line))) failure("malformed-output");
	return lines;
}

async function selectVerifiedMember(archiveBytes, archiveName, memberName, platform, architecture, cwd, reader = runNativeReader) {
	const expected = MANIFESTS[`${platform}/${architecture}`];
	if (!expected || expected.at(-1) !== memberName) fail("unsupported archive manifest");
	const names = parseReaderOutput(await reader(archiveBytes, archiveReaderArgs(archiveName, "list"), cwd, 64 * 1024, { operation: "list" }), "list");
	if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw brandedFailure("native-reader-manifest");
	const rows = parseReaderOutput(await reader(archiveBytes, archiveReaderArgs(archiveName, "verbose"), cwd, 64 * 1024, { operation: "verbose" }), "verbose");
	if (rows.length !== names.length) throw brandedFailure("native-reader-verbose");
	const entries = names.map((name, index) => ({ name, type: rows[index][0] === "-" ? "file" : "non-regular" }));
	return withFailureReason("native-reader-manifest", () => selectEngramMember(entries, memberName));
}

export async function stageVerifiedArchiveMember(archiveBytes, asset, platform, architecture, cwd, dependencies = {}) {
	if (platform === "win32") {
		try { validateOfficialZipBuffer(archiveBytes, asset, platform, architecture); } catch { throw brandedFailure("zip-validation"); }
		let extracted;
		try { extracted = extractZipMember(archiveBytes, "engram.exe"); } catch { throw brandedFailure("zip-extraction"); }
		return deliverEngramMember(platform, extracted, dependencies.stageDarwin);
	}
	const reader = dependencies.runNativeReader ?? runNativeReader;
	const memberName = "engram";
	await selectVerifiedMember(archiveBytes, asset.name, memberName, platform, architecture, cwd, reader);
	const extracted = await reader(archiveBytes, archiveReaderArgs(asset.name, "extract", memberName), cwd, MAX_BINARY_BYTES, { operation: "extract" });
	return deliverEngramMember(platform, extracted, dependencies.stageDarwin);
}

async function writeExclusiveBinary(path, bytes) {
	await assertRealDirectoryChain(dirname(path));
	const handle = await open(path, exclusiveBinaryWriteFlags(), 0o700);
	try { await handle.writeFile(bytes); await handle.chmod(0o700); await handle.sync(); } finally { await handle.close(); }
}

async function stage() {
	const platform = process.platform;
	const asset = resolveEngramReleaseAsset(platform, process.arch);
	const layout = resolveStageLayout(process.env.RUNNER_TEMP);
	await assertRealDirectoryChain(layout.runnerTemp);
	await assertRealDirectoryChain(layout.preflight);
	const archivePath = join(layout.preflight, asset.name);
	const archiveBytes = await withFailureReason("archive-read", () => readBoundedRegularFile(archivePath, layout.preflight, MAX_ARCHIVE_BYTES));
	if (sha256(archiveBytes) !== asset.sha256) throw brandedFailure("archive-digest");
	const disposition = await withFailureReason("native-reader-extract", () => stageVerifiedArchiveMember(
		archiveBytes, asset, platform, process.arch, layout.preflight, {
			stageDarwin: async (bytes) => {
				const expectedDigest = sha256(bytes);
				await withFailureReason("darwin-private-root", () => prepareBin(layout));
				const destination = join(layout.bin, "engram");
				await withFailureReason("darwin-write", () => writeExclusiveBinary(destination, bytes));
				await withFailureReason("darwin-readback", async () => {
					const staged = await readBoundedRegularFile(destination, layout.bin, MAX_BINARY_BYTES);
					if (sha256(bytes) !== expectedDigest || sha256(staged) !== expectedDigest) fail("binary identity mismatch");
					assertBinaryIdentity(bytes, staged);
				});
			},
		},
	));
	return disposition;
}

async function runCli(args) {
	if (args.length !== 1 || args[0] !== "validate") fail("invalid command");
	const disposition = await stage();
	if (disposition === "member-validation-memory-only") console.log(disposition);
	else console.log(`Official core Engram ${ENGRAM_VERSION} staged in disposable Darwin scratch; binary was not run.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runCli(process.argv.slice(2)).catch((error) => {
		console.error(safeFailureCode(error));
		process.exitCode = 1;
	});
}
