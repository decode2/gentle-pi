import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { ENGRAM_VERSION, resolveEngramReleaseAsset, resolveScratchDirectory } from "./manual-native-preflight.mjs";

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

export function assertSafeArchiveName(name) {
	if (typeof name !== "string" || !name || /[\0-\x1f\x7f\\]/.test(name) || name.startsWith("/") || /^[A-Za-z]:/.test(name)) fail("unsafe archive member");
	const parts = name.split("/");
	if (parts.some((part) => !part || part === "." || part === "..")) fail("unsafe archive member");
	return true;
}

export function archiveReaderArgs(archiveName, operation, memberName) {
	const gzip = archiveName.endsWith(".tar.gz"), zip = archiveName.endsWith(".zip");
	if (!gzip && !zip) fail("unsupported archive format");
	if (operation === "list") return [gzip ? "-tzf" : "-tf", "-"];
	if (operation === "verbose") return [gzip ? "-tvzf" : "-tvf", "-"];
	if (operation === "extract") {
		assertSafeArchiveName(memberName);
		return [gzip ? "-xOzf" : "-xOf", "-", memberName];
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
	if (platform === "win32") return "memory-only";
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

async function runTar(bytes, args, cwd, maxOutput) {
	const executable = tarExecutable(process.platform);
	await assertRealDirectoryChain(dirname(executable));
	const reader = await lstat(executable);
	if (!reader.isFile() || reader.isSymbolicLink()) fail("native archive reader unavailable");
	const env = process.platform === "win32"
		? { SystemRoot: process.env.SystemRoot ?? process.env.WINDIR }
		: { PATH: "/usr/bin:/bin", LC_ALL: "C" };
	await assertRealDirectoryChain(cwd);
	const result = spawnSync(executable, args, { cwd, env, input: bytes, maxBuffer: maxOutput, windowsHide: true, encoding: null, stdio: ["pipe", "pipe", "ignore"] });
	if (result.error || result.status !== 0 || !result.stdout) fail("native archive reader failed");
	return result.stdout;
}

function outputLines(bytes) {
	let text;
	try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { fail("invalid archive manifest"); }
	if (!text.endsWith("\n")) fail("invalid archive manifest");
	const lines = text.slice(0, -1).split(/\r?\n/);
	if (lines.some((line) => !line)) fail("invalid archive manifest");
	return lines;
}

async function selectVerifiedMember(archiveBytes, archiveName, memberName, platform, architecture, cwd) {
	const expected = MANIFESTS[`${platform}/${architecture}`];
	if (!expected || expected.at(-1) !== memberName) fail("unsupported archive manifest");
	const names = outputLines(await runTar(archiveBytes, archiveReaderArgs(archiveName, "list"), cwd, 64 * 1024));
	if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) fail("archive manifest mismatch");
	const rows = outputLines(await runTar(archiveBytes, archiveReaderArgs(archiveName, "verbose"), cwd, 64 * 1024));
	if (rows.length !== names.length) fail("archive manifest mismatch");
	const entries = names.map((name, index) => ({ name, type: rows[index][0] === "-" ? "file" : "non-regular" }));
	return selectEngramMember(entries, memberName);
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
	const archiveBytes = await readBoundedRegularFile(archivePath, layout.preflight, MAX_ARCHIVE_BYTES);
	if (sha256(archiveBytes) !== asset.sha256) fail("official archive digest mismatch");
	const memberName = platform === "win32" ? "engram.exe" : "engram";
	await selectVerifiedMember(archiveBytes, asset.name, memberName, platform, process.arch, layout.preflight);
	const extracted = await runTar(archiveBytes, archiveReaderArgs(asset.name, "extract", memberName), layout.preflight, MAX_BINARY_BYTES);
	const disposition = await deliverEngramMember(platform, extracted, async (bytes) => {
		const expectedDigest = sha256(bytes);
		await prepareBin(layout);
		const destination = join(layout.bin, memberName);
		await writeExclusiveBinary(destination, bytes);
		const staged = await readBoundedRegularFile(destination, layout.bin, MAX_BINARY_BYTES);
		if (sha256(bytes) !== expectedDigest || sha256(staged) !== expectedDigest) fail("binary identity mismatch");
		assertBinaryIdentity(bytes, staged);
	});
	return disposition;
}

async function runCli(args) {
	if (args.length !== 1 || args[0] !== "validate") fail("invalid command");
	const disposition = await stage();
	if (disposition === "memory-only") console.log(`Official core Engram ${ENGRAM_VERSION} member inspected in memory on Windows; binary was not staged or run.`);
	else console.log(`Official core Engram ${ENGRAM_VERSION} staged in disposable Darwin scratch; binary was not run.`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runCli(process.argv.slice(2)).catch(() => {
		console.error("Official core Engram member validation failed closed; no binary was run.");
		process.exitCode = 1;
	});
}
