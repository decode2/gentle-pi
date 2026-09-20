import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, realpath, symlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ComposeQuestionnaireMainOptions = {
	readonly sourceRoot: string;
	readonly overlayRoot: string;
	readonly outputRoot: string;
};
type Entry = { kind: "directory" | "file" | "symlink"; mode: number; target?: string };
type Entries = Map<string, Entry>;
const fail = (message: string): never => { throw new Error(`hosted composition: ${message}`); };
const inside = (parent: string, child: string, root = false): boolean => {
	const childRelative = relative(parent, child);
	return (root || childRelative !== "") && childRelative !== ".." && !childRelative.startsWith(`..${sep}`) && !isAbsolute(childRelative);
};
const gitMetadata = (root: string, path: string): boolean => {
	const child = relative(root, path);
	return child === ".git" || child.startsWith(`.git${sep}`);
};
const ordered = (entries: Entries): [string, Entry][] => [...entries].sort(([left], [right]) => left.split(sep).length - right.split(sep).length || left.localeCompare(right));

async function realDirectory(path: string, label: string): Promise<string> {
	const details = await lstat(path).catch(() => fail(`${label} root is missing`));
	if (!details.isDirectory() || details.isSymbolicLink()) fail(`${label} root must be a real directory`);
	return realpath(path);
}

async function outputDirectory(path: string, sourceRoot: string, overlayRoot: string): Promise<string> {
	const details = await lstat(path).catch(() => undefined);
	if (details === undefined) {
		const parent = await realpath(dirname(path));
		const candidate = join(parent, basename(path));
		if (inside(sourceRoot, candidate, true) || inside(overlayRoot, candidate, true)) fail("output root overlaps an input root");
		await mkdir(path);
	} else if (!details.isDirectory() || details.isSymbolicLink()) {
		fail("output root must be a real directory");
	}
	const outputRoot = await realpath(path);
	if (inside(sourceRoot, outputRoot, true) || inside(overlayRoot, outputRoot, true)) fail("output root overlaps an input root");
	if ((await readdir(outputRoot)).length !== 0) fail("output root must be initially empty");
	return outputRoot;
}

async function scanTree(root: string, outputRoot?: string, current = "", entries: Entries = new Map()): Promise<Entries> {
	const source = outputRoot !== undefined;
	// Acquisition .git metadata is provenance-only; the composed runtime is not a public Git checkout.
	if (source && (current === ".git" || current.startsWith(`.git${sep}`))) return entries;
	const path = current ? join(root, current) : root;
	const details = await lstat(path);
	const mode = details.mode & 0o7777;
	if (details.isDirectory()) {
		if (current) entries.set(current, { kind: "directory", mode });
		for (const child of await readdir(path)) await scanTree(root, outputRoot, current ? join(current, child) : child, entries);
	} else if (details.isFile()) {
		entries.set(current, { kind: "file", mode });
	} else if (details.isSymbolicLink()) {
		if (!source) fail(`overlay symlink is not allowed: ${current}`);
		const rawTarget = await readlink(path);
		const targetPath = isAbsolute(rawTarget) ? resolve(rawTarget) : resolve(dirname(path), rawTarget);
		let targetReal: string;
		try { targetReal = await realpath(targetPath); } catch { return fail(`dangling source symlink: ${current}`); }
		if (!inside(root, targetPath) || !inside(root, targetReal) || gitMetadata(root, targetPath) || gitMetadata(root, targetReal)) fail(`source symlink escapes allowed root: ${current}`);
		entries.set(current, { kind: "symlink", mode, target: isAbsolute(rawTarget) ? join(outputRoot!, relative(root, targetPath)) : rawTarget });
	} else {
		fail(`${source ? "source" : "overlay"} entry is not regular: ${current}`);
	}
	return entries;
}

function validateOverlay(overlay: Entries, source: Entries): void {
	if (overlay.get("extensions/ask-user-question.ts")?.kind !== "file") fail("owned extension overlay must be a regular file");
	if (overlay.get("lib/questions")?.kind !== "directory") fail("questionnaire overlay root must be a directory");
	let questionFiles = 0;
	for (const [path, entry] of overlay) {
		const allowed = path === "extensions" || path === "lib" || path === "lib/questions" || path === "extensions/ask-user-question.ts" || path.startsWith("lib/questions/");
		if (!allowed) fail(`unexpected overlay entry: ${path}`);
		if (path.startsWith("lib/questions/") && entry.kind === "file") questionFiles += 1;
		if (path.startsWith("lib/questions/") && entry.kind !== "file" && entry.kind !== "directory") fail(`overlay entry is not regular: ${path}`);
		if (source.has(path) && path !== "extensions" && path !== "lib") fail(`overlay collision: ${path}`);
	}
	for (const shared of ["extensions", "lib"]) if (source.get(shared)?.kind === "symlink" || source.get(shared)?.kind === "file") fail(`overlay collision: ${shared}`);
	if (questionFiles === 0) fail("questionnaire overlay has no regular files");
}

async function safeOutputParent(root: string, destination: string): Promise<void> {
	const child = relative(root, dirname(destination));
	if (isAbsolute(child) || child === ".." || child.startsWith(`..${sep}`)) fail("output entry escaped output root");
	let current = root;
	for (const part of child.split(sep)) {
		if (!part || part === ".") continue;
		current = join(current, part);
		const details = await lstat(current);
		if (!details.isDirectory() || details.isSymbolicLink()) fail(`output ancestor is not a real directory: ${current}`);
	}
}

async function copyEntries(inputRoot: string, outputRoot: string, entries: Entries, overlay = false): Promise<void> {
	for (const [path, entry] of ordered(entries)) {
		const destination = join(outputRoot, path);
		await safeOutputParent(outputRoot, destination);
		const existing = await lstat(destination).catch(() => undefined);
		if (entry.kind === "directory") {
			if (existing !== undefined) {
				if (!overlay || (path !== "extensions" && path !== "lib") || !existing.isDirectory() || existing.isSymbolicLink()) fail(`overlay collision: ${path}`);
				continue;
			}
			await mkdir(destination, { mode: entry.mode });
			await chmod(destination, entry.mode);
		} else {
			if (existing !== undefined) fail(`overlay collision: ${path}`);
			if (entry.kind === "file") {
				await copyFile(join(inputRoot, path), destination, constants.COPYFILE_EXCL);
				await chmod(destination, entry.mode);
			} else {
				await symlink(entry.target!, destination);
			}
		}
	}
}

export async function composeQuestionnaireMainArtifact(options: ComposeQuestionnaireMainOptions): Promise<void> {
	const sourceRoot = await realDirectory(options.sourceRoot, "source");
	const overlayRoot = await realDirectory(options.overlayRoot, "overlay");
	if (inside(sourceRoot, overlayRoot, true) || inside(overlayRoot, sourceRoot, true)) fail("source and overlay roots overlap");
	const outputRoot = await outputDirectory(options.outputRoot, sourceRoot, overlayRoot);
	const source = await scanTree(sourceRoot, outputRoot);
	const overlay = await scanTree(overlayRoot);
	validateOverlay(overlay, source);
	await copyEntries(sourceRoot, outputRoot, source);
	await copyEntries(overlayRoot, outputRoot, overlay, true);
}

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined || value.length === 0) throw new Error(`missing ${name}`);
	return value;
}

if (process.env.GENTLE_PI_COMPOSE_MAIN === "1") {
	await composeQuestionnaireMainArtifact({
		sourceRoot: requiredEnvironment("ACQUIRED_MAIN_ROOT"),
		overlayRoot: requiredEnvironment("QUESTIONNAIRE_OVERLAY_ROOT"),
		outputRoot: requiredEnvironment("COMPOSED_ROOT"),
	});
}
