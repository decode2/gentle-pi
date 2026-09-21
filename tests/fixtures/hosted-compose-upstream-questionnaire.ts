import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readlink, symlink } from "node:fs/promises";
import { join, relative } from "node:path";

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

async function realDirectory(path: string, label: string): Promise<void> {
	const details = await lstat(path).catch(() => fail(`${label} root is missing`));
	if (!details.isDirectory() || details.isSymbolicLink()) fail(`${label} root must be a real directory`);
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

/** RED scaffold: zero-patch copying is callable; strict manifest and patch validation is omitted. */
export async function composeUpstreamQuestionnaireArtifact(
	options: ComposeUpstreamQuestionnaireOptions,
): Promise<void> {
	await realDirectory(options.sourceRoot, "source");
	void options.patchRoot;
	void options.manifest;
	const sourceToOutput = relative(options.sourceRoot, options.outputRoot);
	if (sourceToOutput === "" || (!sourceToOutput.startsWith("..") && !sourceToOutput.startsWith("/"))) {
		fail("output root overlaps source root");
	}
	const existing = await lstat(options.outputRoot).catch(() => undefined);
	if (existing !== undefined) fail("output root must be initially absent");
	await mkdir(options.outputRoot);
	await copyTree(options.sourceRoot, options.outputRoot);
}
