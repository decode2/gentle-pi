import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, readlink, symlink, writeFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { dirname, join, relative } from "node:path";
import test from "node:test";
import {
	composeUpstreamQuestionnaireArtifact,
	type CompositionManifest,
	type ComposeUpstreamQuestionnaireOptions,
	type PatchEntry,
} from "./fixtures/hosted-compose-upstream-questionnaire.ts";

type Manifest = {
	schema: string;
	repository: string;
	commit: string;
	tree: string;
	trackedFileCount: number;
	questionnairePaths: string[];
	package: Record<string, unknown>;
	lock: Record<string, unknown>;
	installedPackages: Array<{ path: string }>;
	composition: CompositionManifest;
};
type Scratch = {
	root: string;
	sourceRoot: string;
	patchRoot: string;
	outputRoot: string;
};

function requiredEnvironment(name: string): string {
	const value = process.env[name];
	if (value === undefined) throw new Error(`missing ${name}`);
	return value;
}
const CHECKOUT_ROOT = "/workspace";
const UPSTREAM_ROOT = "/acquired-upstream";
const ARTIFACT_ROOT = requiredEnvironment("COMPOSITION_ARTIFACT_ROOT");
const MANIFEST_PATH = join(CHECKOUT_ROOT, ".github/workflows/fixtures/hosted-upstream-questionnaire.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const composition = manifest.composition;
const EXPECTED_COMPOSITION = {
	schema: "gentle-pi.hosted-upstream-questionnaire-composition/v1",
	derivedDirectory: "derived",
	patchDirectory: "patches/questionnaire-upstream",
	patchInventory: [],
	allowedTargets: [
		"extensions/ask-user-choice.ts",
		"extensions/ask-user-question.ts",
		"lib/questionnaire/questionnaire-view.ts",
		"lib/questionnaire/schema.ts",
		"lib/questionnaire/validate.ts",
		"tests/ask-user-choice.test.ts",
		"tests/ask-user-question.test.ts",
		"tests/questionnaire-schema.test.ts",
		"tests/questionnaire-view.test.ts",
	],
	protectedTargets: ["lib/native-fullscreen-interaction.ts"],
};
assert.deepEqual(Object.keys(manifest).sort(), [
	"commit", "composition", "installedPackages", "lock", "package", "questionnairePaths", "repository", "schema", "trackedFileCount", "tree",
].sort());
assert.deepEqual(composition, EXPECTED_COMPOSITION);

const gitEnvironment = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
};
function git(args: string[]): string {
	return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "credential.helper=", "-C", UPSTREAM_ROOT, ...args], { env: gitEnvironment, encoding: "utf8" }).trim();
}
function mountOptions(point: string): string[] {
	const line = readFileSync("/proc/self/mountinfo", "utf8").split("\n").find((candidate) => candidate.split(" - ")[0]?.split(" ")[4] === point);
	assert.ok(line, `missing mount readback for ${point}`);
	return line.split(" - ")[0]?.split(" ")[5]?.split(",") ?? [];
}
function blobHash(value: string): string {
	const bytes = Buffer.from(value);
	return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest("hex");
}
function patchText(target: string, before = "old\n", after = "new\n"): string {
	return `diff --git a/${target} b/${target}\nindex ${blobHash(before)}..${blobHash(after)} 100644\n--- a/${target}\n+++ b/${target}\n@@ -1 +1 @@\n-${before}+${after}`;
}
function entry(file: string, target: string, before = "old\n", after = "new\n"): PatchEntry {
	return { file, target, preimage: blobHash(before), postimage: blobHash(after) };
}
async function scratch(name: string, target = "extensions/ask-user-question.ts", kind: "file" | "symlink" | "directory" = "file", sourceText = "old\n"): Promise<Scratch> {
	const root = join(ARTIFACT_ROOT, name);
	const sourceRoot = join(root, "source");
	const targetPath = join(sourceRoot, target);
	await mkdir(dirname(targetPath), { recursive: true });
	if (kind === "file") await writeFile(targetPath, sourceText);
	if (kind === "symlink") {
		await writeFile(join(dirname(targetPath), "real.ts"), sourceText);
		await symlink("real.ts", targetPath);
	}
	if (kind === "directory") await mkdir(targetPath);
	const patchRoot = join(root, composition.patchDirectory);
	const outputRoot = join(root, composition.derivedDirectory);
	await mkdir(patchRoot, { recursive: true });
	return { root, sourceRoot, patchRoot, outputRoot };
}
function optionsFor(scratchCase: Scratch, patches: readonly PatchEntry[]): ComposeUpstreamQuestionnaireOptions {
	return {
		sourceRoot: scratchCase.sourceRoot,
		patchRoot: scratchCase.patchRoot,
		outputRoot: scratchCase.outputRoot,
		manifest: { ...composition, patchInventory: patches },
	};
}
async function writePatch(scratchCase: Scratch, patch: PatchEntry, target = patch.target, before = "old\n", after = "new\n"): Promise<void> {
	await writeFile(join(scratchCase.patchRoot, patch.file), patchText(target, before, after));
}
async function expectStrictReject(
	scratchCase: Scratch,
	patches: readonly PatchEntry[],
	pattern: RegExp,
	sourcePath = join(scratchCase.sourceRoot, "extensions/ask-user-question.ts"),
): Promise<void> {
	const before = await readFile(sourcePath).catch(() => undefined);
	await assert.rejects(composeUpstreamQuestionnaireArtifact(optionsFor(scratchCase, patches)), pattern);
	assert.equal(await lstat(scratchCase.outputRoot).catch(() => undefined), undefined);
	if (before !== undefined) assert.deepEqual(await readFile(sourcePath), before);
}

test("hosted composition uses bounded network-none isolation", () => {
	const expectedCredentials = Object.keys(process.env).filter((key) => /TOKEN|PASSWORD|SECRET|CREDENTIAL|AWS_|GITHUB_/i.test(key));
	assert.deepEqual(expectedCredentials, []);
	const expectedEnvironment = [
		"ACQUIRED_UPSTREAM_ROOT",
		"COMPOSITION_ARTIFACT_ROOT",
		"GENTLE_PI_HOSTED_ISOLATION",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_NOSYSTEM",
		"GIT_CONFIG_SYSTEM",
		"GIT_OPTIONAL_LOCKS",
		"GIT_TERMINAL_PROMPT",
		"HOME",
		"NODE_TEST_WORKER_ID",
		"PATH",
		"PWD",
		"TMPDIR",
	].sort();
	const actualEnvironment = Object.keys(process.env).filter((key) => key !== "NODE_TEST_CONTEXT").sort();
	assert.deepEqual(actualEnvironment, expectedEnvironment);
	assert.equal(process.env.GENTLE_PI_HOSTED_ISOLATION, "docker-network-none-readonly-v1");
	assert.equal(process.env.ACQUIRED_UPSTREAM_ROOT, UPSTREAM_ROOT);
	assert.equal(process.env.PWD, CHECKOUT_ROOT);
	assert.equal(process.env.COMPOSITION_ARTIFACT_ROOT, "/artifact");
	assert.equal(process.getuid?.(), 1000);
	for (const mount of ["/", CHECKOUT_ROOT, UPSTREAM_ROOT]) assert.ok(mountOptions(mount).includes("ro"), `${mount} must be read-only`);
	assert.ok(!mountOptions("/artifact").includes("ro"), "composition artifact must be writable for staging");
	assert.deepEqual(Object.keys(networkInterfaces()).filter((name) => name !== "lo"), []);
	const status = readFileSync("/proc/self/status", "utf8");
	assert.match(status, /^NoNewPrivs:\s+1$/m);
	assert.match(status, /^CapEff:\s+0+$/m);
});

test("zero-patch composition preserves exact source, dependencies, and patch directory identity", async () => {
	const scratchCase = await scratch("zero-patch");
	assert.equal(relative(scratchCase.root, scratchCase.patchRoot), composition.patchDirectory);
	assert.deepEqual(await readdir(scratchCase.patchRoot), []);
	const before = { head: git(["rev-parse", "HEAD"]), tree: git(["rev-parse", "HEAD^{tree}"]), status: git(["status", "--porcelain=v1", "--untracked-files=all"]) };
	await composeUpstreamQuestionnaireArtifact({ sourceRoot: UPSTREAM_ROOT, patchRoot: scratchCase.patchRoot, outputRoot: scratchCase.outputRoot, manifest: composition });
	assert.equal(git(["rev-parse", "HEAD"]), before.head);
	assert.equal(git(["rev-parse", "HEAD^{tree}"]), before.tree);
	assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]), before.status);
	for (const path of [...manifest.questionnairePaths, "package.json", "pnpm-lock.yaml", ...manifest.installedPackages.map((item) => item.path)]) {
		assert.deepEqual(await readFile(join(scratchCase.outputRoot, path)), await readFile(join(UPSTREAM_ROOT, path)), path);
	}
	for (const path of ["node_modules/@earendil-works/pi-tui", "node_modules/typebox"]) {
		const source = await lstat(join(UPSTREAM_ROOT, path));
		const output = await lstat(join(scratchCase.outputRoot, path));
		assert.equal(output.isSymbolicLink(), source.isSymbolicLink(), path);
		if (source.isSymbolicLink()) assert.equal(await readlink(join(scratchCase.outputRoot, path)), await readlink(join(UPSTREAM_ROOT, path)), path);
	}
	assert.equal(await lstat(join(scratchCase.outputRoot, ".git")).catch(() => undefined), undefined);
});

test("rejects wrong preimages and postimages before creating a derived tree", async () => {
	const preimageCase = await scratch("wrong-preimage");
	const preimage = entry("001.patch", "extensions/ask-user-question.ts");
	await writePatch(preimageCase, preimage);
	await expectStrictReject(preimageCase, [{ ...preimage, preimage: "0".repeat(40) }], /preimage/);
	const postimageCase = await scratch("wrong-postimage");
	const postimage = entry("001.patch", "extensions/ask-user-question.ts");
	await writePatch(postimageCase, postimage);
	await expectStrictReject(postimageCase, [{ ...postimage, postimage: "0".repeat(40) }], /postimage/);
});

test("rejects missing or unlisted patch files", async () => {
	const missing = await scratch("missing-patch");
	const missingEntry = entry("001.patch", "extensions/ask-user-question.ts");
	await expectStrictReject(missing, [missingEntry], /missing patch file/);
	const unlisted = await scratch("unlisted-patch");
	const unlistedEntry = entry("001.patch", "extensions/ask-user-question.ts");
	await writePatch(unlisted, unlistedEntry);
	await expectStrictReject(unlisted, [], /unlisted patch file/);
});

test("rejects changed paths outside the deterministic manifest inventory", async () => {
	const changed = await scratch("changed-path");
	const changedEntry = entry("001.patch", "extensions/ask-user-question.ts");
	await writePatch(changed, changedEntry, "extensions/unlisted.ts");
	await expectStrictReject(changed, [changedEntry], /changed path/);
});

for (const [label, target, pattern] of [
	["traversal", "../escape.ts", /target path escapes/],
	["absolute", "/tmp/escape.ts", /target path must be relative/],
	["protected", "lib/native-fullscreen-interaction.ts", /target is protected/],
] as const) {
	test(`rejects ${label} patch targets`, async () => {
		const scratchCase = await scratch(label);
		const patch = entry("001.patch", target);
		await writePatch(scratchCase, patch);
		await expectStrictReject(scratchCase, [patch], pattern);
	});
}

test("rejects duplicate targets and patch offsets", async () => {
	const duplicate = await scratch("duplicate-target");
	const first = entry("001.patch", "extensions/ask-user-question.ts");
	const second = entry("002.patch", "extensions/ask-user-question.ts");
	await writePatch(duplicate, first);
	await writePatch(duplicate, second);
	await expectStrictReject(duplicate, [first, second], /duplicate target/);
	const offset = await scratch("patch-offset", "extensions/ask-user-question.ts", "file", "prefix\nold\n");
	const offsetEntry = entry("001.patch", "extensions/ask-user-question.ts", "prefix\nold\n", "prefix\nnew\n");
	await writeFile(join(offset.patchRoot, offsetEntry.file), `diff --git a/${offsetEntry.target} b/${offsetEntry.target}\nindex ${blobHash("prefix\nold\n")}..${blobHash("prefix\nnew\n")} 100644\n--- a/${offsetEntry.target}\n+++ b/${offsetEntry.target}\n@@ -1 +1 @@\n-old\n+new\n`);
	await expectStrictReject(offset, [offsetEntry], /fuzz|offset/);
	const fuzz = await scratch("patch-fuzz", "extensions/ask-user-question.ts", "file", "prefix\nold\nsuffix\n");
	const fuzzEntry = entry("001.patch", "extensions/ask-user-question.ts", "prefix\nold\nsuffix\n", "prefix\nnew\nsuffix\n");
	await writeFile(join(fuzz.patchRoot, fuzzEntry.file), `diff --git a/${fuzzEntry.target} b/${fuzzEntry.target}\nindex ${blobHash("prefix\nold\nsuffix\n")}..${blobHash("prefix\nnew\nsuffix\n")} 100644\n--- a/${fuzzEntry.target}\n+++ b/${fuzzEntry.target}\n@@ -1,3 +1,3 @@\n wrong-prefix\n-old\n+new\n suffix\n`);
	await expectStrictReject(fuzz, [fuzzEntry], /fuzz|context/);
});

test("rejects symlink and nonregular patch or target entries", async () => {
	const patchLink = await scratch("symlink-patch");
	const linkEntry = entry("001.patch", "extensions/ask-user-question.ts");
	await writePatch(patchLink, { ...linkEntry, file: "real.patch" });
	await symlink("real.patch", join(patchLink.patchRoot, linkEntry.file));
	await expectStrictReject(patchLink, [linkEntry], /patch file must be regular/);
	const patchDirectory = await scratch("directory-patch");
	const directoryEntry = entry("001.patch", "extensions/ask-user-question.ts");
	await mkdir(join(patchDirectory.patchRoot, directoryEntry.file));
	await expectStrictReject(patchDirectory, [directoryEntry], /patch file must be regular/);
	const targetLink = await scratch("symlink-target", "extensions/ask-user-question.ts", "symlink");
	const targetEntry = entry("001.patch", "extensions/ask-user-question.ts");
	await writePatch(targetLink, targetEntry);
	await expectStrictReject(targetLink, [targetEntry], /target must be regular/);
	const targetDirectory = await scratch("directory-target", "extensions/ask-user-question.ts", "directory");
	await writePatch(targetDirectory, targetEntry);
	await expectStrictReject(targetDirectory, [targetEntry], /target must be regular/);
});

const COMPOSITION_V2 = "gentle-pi.hosted-upstream-questionnaire-composition/v2";

function v2Options(scratchCase: Scratch, patches: readonly PatchEntry[]): ComposeUpstreamQuestionnaireOptions {
	return {
		...optionsFor(scratchCase, patches),
		manifest: { ...composition, schema: COMPOSITION_V2, patchInventory: patches },
	};
}

async function writeSourceFile(scratchCase: Scratch, target: string, sourceText = "old\n", mode = 0o644): Promise<void> {
	const path = join(scratchCase.sourceRoot, target);
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, sourceText, { mode });
}

function contentAndModePatchText(contentTarget: string, modeTarget: string): string {
	return `${patchText(contentTarget)}diff --git a/${modeTarget} b/${modeTarget}\nold mode 100644\nnew mode 100755\n`;
}

async function expectV2Reject(
	scratchCase: Scratch,
	patches: readonly PatchEntry[],
	pattern: RegExp,
	sourcePaths: readonly string[],
): Promise<void> {
	const before = new Map(
		await Promise.all(sourcePaths.map(async (path) => [path, await readFile(join(scratchCase.sourceRoot, path))] as const)),
	);
	await assert.rejects(composeUpstreamQuestionnaireArtifact(v2Options(scratchCase, patches)), pattern);
	assert.equal(await lstat(scratchCase.outputRoot).catch(() => undefined), undefined);
	for (const [path, bytes] of before) assert.deepEqual(await readFile(join(scratchCase.sourceRoot, path)), bytes, path);
}

test("v2 composes contiguous manifest-ordered patch chains with exact bytes", async () => {
	const scratchCase = await scratch("v2-chain");
	const firstTarget = "extensions/ask-user-question.ts";
	const secondTarget = "lib/questionnaire/schema.ts";
	await writeSourceFile(scratchCase, secondTarget);
	const first = entry("z-a1.patch", firstTarget, "old\n", "a1\n");
	const second = entry("a-a2.patch", firstTarget, "a1\n", "a2\n");
	const third = entry("m-b1.patch", secondTarget, "old\n", "b1\n");
	await writePatch(scratchCase, first, firstTarget, "old\n", "a1\n");
	await writePatch(scratchCase, second, firstTarget, "a1\n", "a2\n");
	await writePatch(scratchCase, third, secondTarget, "old\n", "b1\n");
	await composeUpstreamQuestionnaireArtifact(v2Options(scratchCase, [first, second, third]));
	assert.deepEqual(await readFile(join(scratchCase.outputRoot, firstTarget)), Buffer.from("a2\n"));
	assert.deepEqual(await readFile(join(scratchCase.outputRoot, secondTarget)), Buffer.from("b1\n"));
});

test("v2 rejects broken same-target continuity before producing output", async () => {
	const scratchCase = await scratch("v2-broken-continuity");
	const target = "extensions/ask-user-question.ts";
	const first = entry("z-a1.patch", target, "old\n", "a1\n");
	const broken = entry("a-a2.patch", target, "not-a1\n", "a2\n");
	await writePatch(scratchCase, first, target, "old\n", "a1\n");
	await writePatch(scratchCase, broken, target, "not-a1\n", "a2\n");
	await expectV2Reject(scratchCase, [first, broken], /continuity/, [target]);
});

test("v2 rejects interleaved same-target chains before applying patches", async () => {
	const scratchCase = await scratch("v2-interleaved-chain");
	const firstTarget = "extensions/ask-user-question.ts";
	const secondTarget = "lib/questionnaire/schema.ts";
	await writeSourceFile(scratchCase, secondTarget);
	const first = entry("z-a1.patch", firstTarget, "old\n", "a1\n");
	const interleaved = entry("m-b1.patch", secondTarget, "old\n", "b1\n");
	const final = entry("a-a2.patch", firstTarget, "a1\n", "a2\n");
	await writePatch(scratchCase, first, firstTarget, "old\n", "a1\n");
	await writePatch(scratchCase, interleaved, secondTarget, "old\n", "b1\n");
	await writePatch(scratchCase, final, firstTarget, "a1\n", "a2\n");
	await expectV2Reject(scratchCase, [first, interleaved, final], /contiguous|interleav/, [firstTarget, secondTarget]);
});

test("v2 cleans the stage after a later sequential patch failure", async () => {
	const scratchCase = await scratch("v2-late-failure");
	const target = "extensions/ask-user-question.ts";
	const first = entry("z-a1.patch", target, "old\n", "a1\n");
	const second = entry("a-a2.patch", target, "a1\n", "a2\n");
	await writePatch(scratchCase, first, target, "old\n", "a1\n");
	await writePatch(scratchCase, second, target, "a1\n", "a2\n");
	await expectV2Reject(scratchCase, [first, { ...second, postimage: "0".repeat(40) }], /postimage/, [target]);
	assert.deepEqual((await readdir(scratchCase.root)).filter((name) => name.startsWith(".questionnaire-stage-")), []);
});

test("v2 rejects metadata-only multipath patches before changing source modes", async () => {
	const scratchCase = await scratch("v2-metadata-multipath");
	const contentTarget = "extensions/ask-user-question.ts";
	const modeTarget = "lib/questionnaire/schema.ts";
	await writeSourceFile(scratchCase, modeTarget, "old\n", 0o644);
	const patch = entry("metadata.patch", contentTarget);
	await writeFile(join(scratchCase.patchRoot, patch.file), contentAndModePatchText(contentTarget, modeTarget));
	const contentPath = join(scratchCase.sourceRoot, contentTarget);
	const modePath = join(scratchCase.sourceRoot, modeTarget);
	const beforeContentMode = (await lstat(contentPath)).mode & 0o7777;
	const beforeMode = (await lstat(modePath)).mode & 0o7777;
	await expectV2Reject(scratchCase, [patch], /metadata|multiple|changed path/, [contentTarget, modeTarget]);
	assert.equal((await lstat(contentPath)).mode & 0o7777, beforeContentMode);
	assert.equal((await lstat(modePath)).mode & 0o7777, beforeMode);
});

test("v2 rejects targets beneath symlink ancestors before applying", async () => {
	const scratchCase = await scratch("v2-symlink-ancestor");
	const target = "lib/questionnaire/schema.ts";
	const externalRoot = join(scratchCase.root, "external");
	const externalTarget = join(externalRoot, "schema.ts");
	await mkdir(externalRoot, { recursive: true });
	await writeFile(externalTarget, "old\n");
	await mkdir(join(scratchCase.sourceRoot, "lib"), { recursive: true });
	const ancestor = join(scratchCase.sourceRoot, "lib", "questionnaire");
	await symlink(externalRoot, ancestor);
	const patch = entry("symlink.patch", target);
	await writePatch(scratchCase, patch, target);
	await expectV2Reject(scratchCase, [patch], /symlink|ancestor/, [target]);
	assert.deepEqual(await readFile(externalTarget), Buffer.from("old\n"));
});
