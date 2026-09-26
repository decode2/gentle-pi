import { lstat, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync } from "node:zlib";
import { verifyNpmIntegrity } from "./manual-native-preflight.mjs";
import { assertRealDirectoryChain, readBoundedRegularFile, resolveRuntimeLayout, STAGED_PACKAGES } from "./manual-native-runtime.mjs";

const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const MAX_NESTED_ENTRIES = 10000;
const MAX_NESTED_BYTES = 256 * 1024 * 1024;
const MAX_NESTED_FILE_BYTES = 64 * 1024 * 1024;
const UNVERIFIED_PI_PACKAGE = "@earendil-works/pi-coding-agent";
const DEFAULT_LIMITS = Object.freeze({ maxDecompressedBytes: 128 * 1024 * 1024, maxEntries: 20000, maxEntryBytes: 16 * 1024 * 1024, maxTotalBytes: 128 * 1024 * 1024 });
const SAFE_FAILURES = new Set(["invalid package archive", "unsafe archive entry", "archive limits exceeded", "invalid staged archive", "package content mismatch", "unsafe installed package", "staged archive changed"]);
const fail = (message) => { throw new Error(message); };
const isLimit = (value) => Number.isSafeInteger(value) && value > 0;

function textField(header, start, length) {
	const field = header.subarray(start, start + length), end = field.indexOf(0);
	try { return new TextDecoder("utf-8", { fatal: true }).decode(end < 0 ? field : field.subarray(0, end)); }
	catch { fail("unsafe archive entry"); }
}

function octalField(header, start, length) {
	const value = header.subarray(start, start + length).toString("ascii").replace(/[\0 ]+$/g, "").replace(/^ +/g, "");
	if (!value) return 0;
	if (!/^[0-7]+$/.test(value)) fail("invalid package archive");
	const number = Number.parseInt(value, 8);
	if (!Number.isSafeInteger(number)) fail("archive limits exceeded");
	return number;
}

function safeComponent(value) {
	return Boolean(value) && value !== "." && value !== ".." && !/[\\/:\0-\x1f<>:"|?*]/.test(value) && !/[ .]$/.test(value) && Buffer.byteLength(value) <= 255 && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

export function parsePackageArchive(input, requestedLimits = {}) {
	const limits = { ...DEFAULT_LIMITS, ...requestedLimits };
	if (!(input instanceof Uint8Array) || !Object.values(limits).every(isLimit) || input.byteLength > MAX_ARCHIVE_BYTES) fail("archive limits exceeded");
	let tar;
	try { tar = gunzipSync(Buffer.from(input), { maxOutputLength: limits.maxDecompressedBytes }); }
	catch { fail("archive limits exceeded"); }
	if (!tar.length || tar.length % 512 !== 0 || tar.length > limits.maxDecompressedBytes) fail("invalid package archive");
	const files = new Map(), directories = new Set(), nodes = new Map(), descendants = new Set();
	let offset = 0, count = 0, total = 0, ended = false;
	while (offset < tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) {
			if (offset + 1024 > tar.length || !tar.subarray(offset + 512, offset + 1024).every((byte) => byte === 0) || !tar.subarray(offset + 1024).every((byte) => byte === 0)) fail("invalid package archive");
			ended = true;
			break;
		}
		const checksum = octalField(header, 148, 8);
		const actualChecksum = header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0);
		if (checksum !== actualChecksum || header.toString("ascii", 257, 263) !== "ustar\0" || header.toString("ascii", 263, 265) !== "00") fail("invalid package archive");
		if (++count > limits.maxEntries) fail("archive limits exceeded");
		const size = octalField(header, 124, 12), rawName = textField(header, 0, 100), prefix = textField(header, 345, 155);
		const name = prefix ? `${prefix}/${rawName}` : rawName, flag = header[156];
		const kind = flag === 0 || flag === 48 ? "file" : flag === 53 ? "directory" : "";
		if (!kind) fail("unsafe archive entry");
		if (kind === "file" && size > limits.maxEntryBytes) fail("archive limits exceeded");
		if (kind === "directory" && size !== 0) fail("unsafe archive entry");
		const trimmed = kind === "directory" && name.endsWith("/") ? name.slice(0, -1) : name;
		if (kind === "directory" && trimmed.endsWith("/") || kind === "file" && name.endsWith("/") || trimmed !== "package" && !trimmed.startsWith("package/")) fail("unsafe archive entry");
		const relativeName = trimmed === "package" ? "" : trimmed.slice("package/".length), parts = relativeName ? relativeName.split("/") : [];
		if (parts.some((part) => !safeComponent(part)) || !relativeName && kind !== "directory") fail("unsafe archive entry");
		const key = relativeName;
		if (nodes.has(key)) fail("unsafe archive entry");
		let parent = "";
		for (const part of parts.slice(0, -1)) {
			if (nodes.get(parent) === "file") fail("unsafe archive entry");
			parent = parent ? `${parent}/${part}` : part;
			descendants.add(parent);
			directories.add(parent);
		}
		if (nodes.get(parent) === "file" || kind === "file" && descendants.has(key)) fail("unsafe archive entry");
		if (kind === "directory" && key) directories.add(key);
		nodes.set(key, kind);
		const padded = Math.ceil(size / 512) * 512, dataStart = offset + 512;
		if (dataStart + padded > tar.length) fail("invalid package archive");
		if (kind === "file") {
			total += size;
			if (total > limits.maxTotalBytes) fail("archive limits exceeded");
			files.set(key, Buffer.from(tar.subarray(dataStart, dataStart + size)));
		}
		offset = dataStart + padded;
	}
	if (!ended) fail("invalid package archive");
	files.directories = directories;
	return files;
}

const nestedPath = (name) => name.startsWith("node_modules/");
const nestedDirectory = (name) => name === "node_modules" || nestedPath(name);

export function assertNestedDependencyLimits(entries, bytes, fileBytes = 0) {
	if (!Number.isSafeInteger(entries) || entries < 0 || entries > MAX_NESTED_ENTRIES || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_NESTED_BYTES || !Number.isSafeInteger(fileBytes) || fileBytes < 0 || fileBytes > MAX_NESTED_FILE_BYTES) fail("archive limits exceeded");
	return true;
}

export function comparePackageFiles(expected, actual, { allowNestedDependencies = false } = {}) {
	if (!(expected instanceof Map) || !(actual instanceof Map)) fail("package content mismatch");
	for (const [name, bytes] of expected) {
		const installed = actual.get(name);
		if (!(bytes instanceof Uint8Array) || !(installed instanceof Uint8Array) || !Buffer.from(bytes).equals(Buffer.from(installed))) fail("package content mismatch");
	}
	for (const name of actual.keys()) if (!expected.has(name) && !(allowNestedDependencies && nestedPath(name))) fail("package content mismatch");
	const expectedDirs = expected.directories ?? new Set(), actualDirs = actual.directories ?? new Set();
	for (const name of expectedDirs) if (!actualDirs.has(name)) fail("package content mismatch");
	for (const name of actualDirs) if (!expectedDirs.has(name) && !(allowNestedDependencies && nestedDirectory(name))) fail("package content mismatch");
	return true;
}

export function assertArchiveUnchanged(before, after) {
	if (!(before instanceof Uint8Array) || !(after instanceof Uint8Array) || !Buffer.from(before).equals(Buffer.from(after))) fail("staged archive changed");
	return true;
}

const realIO = Object.freeze({
	assertDirectoryChain: assertRealDirectoryChain,
	readdir: async (path) => readdir(path),
	lstat,
	readFile: (layout, path, maxBytes) => readBoundedRegularFile(layout, path, layout.prefix, maxBytes),
});

export async function collectInstalledFiles(layout, packageRoot, io = realIO, { allowNestedDependencies = false } = {}) {
	const root = resolve(packageRoot), prefix = resolve(layout.prefix), fromPrefix = relative(prefix, root);
	if (!fromPrefix || fromPrefix.startsWith(`..${sep}`) || fromPrefix === ".." || isAbsolute(fromPrefix)) fail("unsafe installed package");
	const files = new Map(), directories = new Set();
	let count = 0, total = 0, nestedEntries = 0, nestedTotal = 0;
	async function visit(directory, parentName) {
		await io.assertDirectoryChain(directory);
		const names = await io.readdir(directory);
		if (!Array.isArray(names)) fail("unsafe installed package");
		for (const name of names) {
			if (typeof name !== "string" || !safeComponent(name) || ++count > DEFAULT_LIMITS.maxEntries) fail("unsafe installed package");
			const path = join(directory, name), relativeName = parentName ? `${parentName}/${name}` : name;
			const info = await io.lstat(path);
			if (info.isSymbolicLink()) fail("unsafe installed package");
			const isDirectory = info.isDirectory();
			const nested = allowNestedDependencies && (relativeName.startsWith("node_modules/") || isDirectory && relativeName === "node_modules");
			if (isDirectory) {
				if (nested) assertNestedDependencyLimits(++nestedEntries, nestedTotal);
				directories.add(relativeName);
				await visit(path, relativeName);
				continue;
			}
			if (!info.isFile()) fail("unsafe installed package");
			const maxBytes = nested ? MAX_NESTED_FILE_BYTES : DEFAULT_LIMITS.maxEntryBytes;
			const bytes = await io.readFile(layout, path, maxBytes);
			if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) fail("archive limits exceeded");
			if (nested) assertNestedDependencyLimits(++nestedEntries, nestedTotal += bytes.byteLength, bytes.byteLength);
			else if ((total += bytes.byteLength) > DEFAULT_LIMITS.maxTotalBytes) fail("archive limits exceeded");
			files.set(relativeName, Buffer.from(bytes));
		}
	}
	await visit(root, "");
	files.directories = directories;
	files.nested = Object.freeze({ entries: nestedEntries, bytes: nestedTotal });
	return files;
}

function installedDirectory(layout, packageName) {
	const parts = packageName.split("/");
	if (!(parts.length === 1 || parts.length === 2 && /^@[a-z0-9][a-z0-9._-]*$/i.test(parts[0])) || parts.some((part) => !safeComponent(part))) fail("unsafe installed package");
	return join(layout.prefix, "node_modules", ...parts);
}

async function readStagedArchive(layout, spec) {
	return readBoundedRegularFile(layout, join(layout.preflight, spec.archiveName), layout.preflight, MAX_ARCHIVE_BYTES);
}

export async function verifyPublishedPackageFiles(layout, packages = STAGED_PACKAGES, options = {}) {
	const readArchive = options.readArchive ?? readStagedArchive, io = options.io ?? realIO, trusted = [];
	try {
		if (!Array.isArray(packages) || !packages.length) fail("invalid staged archive");
		const packageNames = new Set(), archiveNames = new Set();
		for (const spec of packages) {
			if (!spec || typeof spec.name !== "string" || !safeComponent(spec.archiveName) || packageNames.has(spec.name) || archiveNames.has(spec.archiveName)) fail("invalid staged archive");
			packageNames.add(spec.name);
			archiveNames.add(spec.archiveName);
			const archive = Buffer.from(await readArchive(layout, spec));
			try { verifyNpmIntegrity(archive, spec.integrity); } catch { fail("invalid staged archive"); }
			const expected = parsePackageArchive(archive), root = installedDirectory(layout, spec.name);
			const allowNestedDependencies = spec.name === UNVERIFIED_PI_PACKAGE;
			const actual = await collectInstalledFiles(layout, root, io, { allowNestedDependencies });
			comparePackageFiles(expected, actual, { allowNestedDependencies });
			trusted.push({ spec, archive });
		}
		for (const { spec, archive } of trusted) assertArchiveUnchanged(archive, Buffer.from(await readArchive(layout, spec)));
		return true;
	} catch (error) {
		if (SAFE_FAILURES.has(error?.message)) throw error;
		fail("unsafe installed package");
	}
}

async function runCli(args) {
	if (args.length !== 1 || args[0] !== "verify") fail("invalid staged archive");
	await verifyPublishedPackageFiles(resolveRuntimeLayout(process.env.RUNNER_TEMP));
	console.log("Published package files match; nested Pi dependencies unverified; no postinstall/Pi execution or Ready.");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runCli(process.argv.slice(2)).catch(() => { console.error("Published package file check failed closed; nested Pi dependencies remain unverified."); process.exitCode = 1; });
}
