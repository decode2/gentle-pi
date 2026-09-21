import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readlink, rename, rm, symlink } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";

export type PatchEntry = {
	readonly file: string;
	readonly target: string;
	readonly preimage: string;
	readonly postimage: string;
};
export type CompositionManifest = {
	readonly schema: string;
	readonly derivedDirectory: string;
	readonly patchDirectory: string;
	readonly patchInventory: readonly PatchEntry[];
	readonly allowedTargets: readonly string[];
	readonly protectedTargets: readonly string[];
};
export type ComposeUpstreamQuestionnaireOptions = {
	readonly sourceRoot: string;
	readonly patchRoot: string;
	readonly outputRoot: string;
	readonly manifest: CompositionManifest;
};

const fail = (message: string): never => { throw new Error(`hosted composition: ${message}`); };
const outputLimit = 256 * 1024;

function git(args: string[], cwd: string, context: string): string {
	const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: outputLimit });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error || result.status !== 0) fail(`${context}: ${output.slice(0, 4096)}`);
	return output;
}
function safePath(value: string, label: string): string {
	if (!value || isAbsolute(value)) fail(`${label} path must be relative`);
	if (value === "." || value === ".." || normalize(value) !== value || value.startsWith(`..${sep}`)) fail(`${label} path escapes root`);
	return value;
}
async function validate(options: ComposeUpstreamQuestionnaireOptions): Promise<readonly PatchEntry[]> {
	const manifest = options.manifest;
	const v2 = manifest.schema === "gentle-pi.hosted-upstream-questionnaire-composition/v2";
	if (!v2 && manifest.schema !== "gentle-pi.hosted-upstream-questionnaire-composition/v1") fail("manifest schema changed");
	if (manifest.patchDirectory !== "patches/questionnaire-upstream" || manifest.derivedDirectory !== "derived") fail("patch directory identity changed");
	if (!options.patchRoot.endsWith(`${sep}${manifest.patchDirectory}`) || !options.outputRoot.endsWith(`${sep}${manifest.derivedDirectory}`)) fail("patch directory identity changed");
	if (!Array.isArray(manifest.patchInventory) || !Array.isArray(manifest.allowedTargets) || !Array.isArray(manifest.protectedTargets)) fail("manifest path policy changed");
	await realDirectory(options.sourceRoot, "source");
	await realDirectory(options.patchRoot, "patch");
	if (await lstat(options.outputRoot).catch(() => undefined)) fail("output root must be initially absent");
	const files = await readdir(options.patchRoot);
	const listed = new Set<string>();
	const targets = new Set<string>();
	const postimages = new Map<string, string>();
	let previousTarget: string | undefined;
	const patches: PatchEntry[] = [];
	for (const patch of manifest.patchInventory) {
		if (!patch || typeof patch.file !== "string" || typeof patch.target !== "string") fail("patch inventory entry invalid");
		const file = safePath(patch.file, "patch file");
		const target = safePath(patch.target, "target");
		const priorPostimage = postimages.get(target);
		if (listed.has(file)) fail("duplicate patch file");
		if (!v2 && targets.has(target)) fail("duplicate target");
		if (v2 && targets.has(target) && previousTarget !== target) fail("v2 target chain is interleaved and must be contiguous");
		if (v2 && priorPostimage !== undefined && patch.preimage !== priorPostimage) fail("v2 same-target patch continuity mismatch");
		listed.add(file);
		targets.add(target);
		previousTarget = target;
		if (manifest.protectedTargets.includes(target)) fail("target is protected");
		if (!manifest.allowedTargets.includes(target)) fail("target is not allowed");
		if (!/^[0-9a-f]{40}$/.test(patch.preimage) || !/^[0-9a-f]{40}$/.test(patch.postimage)) fail("patch hash invalid");
		const patchPath = join(options.patchRoot, file);
		const patchDetails = await lstat(patchPath).catch(() => undefined);
		if (patchDetails === undefined) return fail("missing patch file");
		if (!patchDetails.isFile() || patchDetails.isSymbolicLink()) fail("patch file must be regular");
		await realTargetAncestors(options.sourceRoot, target);
		const targetPath = join(options.sourceRoot, target);
		const targetDetails = await lstat(targetPath).catch(() => undefined);
		if (!targetDetails?.isFile() || targetDetails.isSymbolicLink()) fail("target must be regular");
		const changed = git(["apply", "--numstat", "--summary", "--unsafe-paths", patchPath], options.sourceRoot, "changed path inventory");
		const summary = changed.replace(/^.*\t.*$/gm, "");
		if (/\b(?:create mode|delete mode|old mode|new mode|mode change|rename|copy|type change)\b/i.test(summary)) fail("patch metadata side effect is not allowed");
		const changedPaths = changed.split("\n").filter((line) => line.includes("\t")).map((line) => line.slice(line.lastIndexOf("\t") + 1)).filter(Boolean);
		if (changedPaths.length !== 1 || changedPaths[0] !== target) fail("changed path inventory mismatch");
		if ((!v2 || priorPostimage === undefined) && git(["hash-object", "--no-filters", "--", target], options.sourceRoot, "preimage").trim() !== patch.preimage) fail("preimage mismatch");
		postimages.set(target, patch.postimage);
		patches.push(patch);
	}
	for (const file of files) {
		const details = await lstat(join(options.patchRoot, file));
		if (!details.isFile() || details.isSymbolicLink()) fail("patch file must be regular");
		if (!listed.has(file)) fail("unlisted patch file");
	}
	return patches;
}
function applyPatch(stage: string, patchRoot: string, patch: PatchEntry): void {
	const patchPath = join(patchRoot, patch.file);
	const args = ["apply", "--check", "--verbose", "--recount", "--whitespace=nowarn", "--unsafe-paths", patchPath];
	const check = git(args, stage, "patch context/fuzz invalid");
	if (/\b(offset|fuzz)\b/i.test(check)) fail("patch offset/fuzz is not allowed");
	git(["apply", "--recount", "--whitespace=nowarn", "--unsafe-paths", patchPath], stage, "patch context/fuzz invalid");
}

async function realDirectory(path: string, label: string): Promise<void> {
	const details = await lstat(path).catch(() => fail(`${label} root is missing`));
	if (!details.isDirectory() || details.isSymbolicLink()) fail(`${label} root must be a real directory`);
}

async function realTargetAncestors(root: string, target: string): Promise<void> {
	let current = root;
	for (const segment of target.split(sep).slice(0, -1)) {
		current = join(current, segment);
		const details = await lstat(current).catch(() => fail("target ancestor is missing"));
		if (!details.isDirectory() || details.isSymbolicLink()) fail("target ancestor must be a real directory");
	}
}

async function copyTree(sourceRoot: string, outputRoot: string, current = ""): Promise<void> {
	const source = current ? join(sourceRoot, current) : sourceRoot;
	for (const child of await readdir(source)) {
		if (!current && child === ".git") continue;
		const path = current ? join(current, child) : child;
		const input = join(sourceRoot, path);
		const output = join(outputRoot, path);
		const details = await lstat(input);
		const mode = details.mode & 0o7777;
		if (details.isDirectory()) {
			await mkdir(output, { mode: 0o700 });
			await copyTree(sourceRoot, outputRoot, path);
			await chmod(output, mode);
		} else if (details.isFile()) {
			await copyFile(input, output, constants.COPYFILE_EXCL);
			await chmod(output, mode);
		} else if (details.isSymbolicLink()) {
			await symlink(await readlink(input), output);
		} else {
			fail(`source entry is not regular: ${path}`);
		}
	}
}

export async function composeUpstreamQuestionnaireArtifact(
	options: ComposeUpstreamQuestionnaireOptions,
): Promise<void> {
	const sourceToOutput = relative(options.sourceRoot, options.outputRoot);
	if (sourceToOutput === "" || (!sourceToOutput.startsWith("..") && !sourceToOutput.startsWith("/"))) fail("output root overlaps source root");
	const patches = await validate(options);
	let stage: string | undefined;
	try {
		stage = await mkdtemp(join(dirname(options.outputRoot), ".questionnaire-stage-"));
		await copyTree(options.sourceRoot, stage);
		for (const patch of patches) {
			await realTargetAncestors(stage, patch.target);
			const targetPath = join(stage, patch.target);
			const details = await lstat(targetPath).catch(() => undefined);
			if (!details?.isFile() || details.isSymbolicLink()) fail("target must be regular");
			if (git(["hash-object", "--no-filters", "--", patch.target], stage, "preimage").trim() !== patch.preimage) fail("preimage mismatch");
			applyPatch(stage, options.patchRoot, patch);
			const finalDetails = await lstat(targetPath).catch(() => undefined);
			if (!finalDetails?.isFile() || finalDetails.isSymbolicLink()) fail("target must be regular");
			if (git(["hash-object", "--no-filters", "--", patch.target], stage, "postimage").trim() !== patch.postimage) fail("postimage mismatch");
		}
		await rename(stage, options.outputRoot);
		stage = undefined;
	} finally {
		if (stage) await rm(stage, { recursive: true, force: true });
	}
}
