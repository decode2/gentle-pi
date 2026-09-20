import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type { Stats } from "node:fs";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import test from "node:test";
import { composeQuestionnaireMainArtifact } from "./fixtures/hosted-compose-questionnaire-main.ts";

type TreeEntry = { kind: "directory" | "file" | "symlink"; mode: number; digest?: string; target?: string };
type Tree = Map<string, TreeEntry>;
type ScratchFixture = { root: string; source: string; overlay: string; output: string };

type AcquisitionManifest = { native: { asset: string; assetSha256: string; binarySha256: string } };

const CHECKOUT_ROOT = "/workspace";
const MAIN_ROOT = "/acquired-main";
const ARTIFACT_ROOT = "/acquired-artifacts";
const COMPOSED_ROOT = "/composed";
const manifest = JSON.parse(readFileSync(join(CHECKOUT_ROOT, ".github/workflows/fixtures/questionnaire-main-acquisition.json"), "utf8")) as AcquisitionManifest;
const gitEnvironment = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };

function mountOptions(point: string): string[] {
	const line = readFileSync("/proc/self/mountinfo", "utf8").split("\n").find((candidate) => candidate.split(" - ")[0]?.split(" ")[4] === point);
	assert.ok(line, `missing mount readback for ${point}`);
	return line.split(" - ")[0]!.split(" ")[5]!.split(",");
}

function git(args: string[]): string {
	return execFileSync("git", ["-C", MAIN_ROOT, ...args], { env: gitEnvironment, encoding: "utf8" }).trim();
}

async function collectTree(root: string, current = "", entries: Tree = new Map()): Promise<Tree> {
	if (current.split("/").includes(".git")) return entries;
	const path = current.length === 0 ? root : join(root, current);
	let details: Stats;
	try {
		details = await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return entries;
		throw error;
	}
	const mode = details.mode & 0o7777;
	if (details.isDirectory()) {
		if (current.length > 0) entries.set(current, { kind: "directory", mode });
		for (const child of await readdir(path)) await collectTree(root, current.length === 0 ? child : join(current, child), entries);
		return entries;
	}
	if (details.isSymbolicLink()) {
		entries.set(current, { kind: "symlink", mode, target: await readlink(path) });
		return entries;
	}
	assert.ok(details.isFile(), `unsupported nonregular tree entry: ${current}`);
	entries.set(current, { kind: "file", mode, digest: createHash("sha256").update(await readFile(path)).digest("hex") });
	return entries;
}

function assertWithin(parent: string, child: string, label: string): void {
	const childRelative = relative(parent, child);
	assert.notEqual(childRelative, "", `${label} must be below its parent`);
	assert.equal(isAbsolute(childRelative), false, `${label} escaped its parent`);
	assert.equal(childRelative.startsWith(".."), false, `${label} escaped its parent`);
}

async function assertSymlinksConfined(root: string, tree: Tree): Promise<void> {
	const realRoot = await realpath(root);
	for (const [path, entry] of tree) {
		if (entry.kind !== "symlink") continue;
		const link = join(root, path);
		const target = entry.target!;
		const candidate = isAbsolute(target) ? resolve(target) : resolve(dirname(link), target);
		let targetReal: string;
		try {
			targetReal = await realpath(candidate);
		} catch {
			assert.fail(`composed symlink target is missing: ${path} -> ${target}`);
			continue;
		}
		assertWithin(realRoot, targetReal, `composed symlink ${path}`);
	}
}

function expectedOutputLinkTarget(sourceTarget: string): string {
	if (!isAbsolute(sourceTarget)) return sourceTarget;
	const resolved = resolve(sourceTarget);
	assertWithin(MAIN_ROOT, resolved, `acquired absolute symlink target ${sourceTarget}`);
	return join(COMPOSED_ROOT, relative(MAIN_ROOT, resolved));
}

function overlayPath(path: string): boolean {
	return path === "extensions/ask-user-question.ts" || path === "lib/questions" || path.startsWith("lib/questions/");
}

async function assertComposedArtifact(): Promise<void> {
	const source = await collectTree(MAIN_ROOT);
	const output = await collectTree(COMPOSED_ROOT);
	assert.ok(output.has("package.json"), "composition must preserve the main package");
	for (const [path, expected] of source) {
		const actual = output.get(path);
		assert.ok(actual, `composition omitted acquired entry: ${path}`);
		assert.equal(actual.kind, expected.kind, `composition changed entry kind: ${path}`);
		if (expected.kind === "file") {
			assert.equal(actual.digest, expected.digest, `composition changed original bytes: ${path}`);
			assert.equal(actual.mode, expected.mode, `composition changed file mode: ${path}`);
		}
	}
	for (const path of output.keys()) assert.equal(source.has(path) || overlayPath(path), true, `composition copied unexpected entry: ${path}`);
	const sourceLinks = [...source].filter(([, entry]) => entry.kind === "symlink").map(([path]) => path).sort();
	const outputLinks = [...output].filter(([, entry]) => entry.kind === "symlink").map(([path]) => path).sort();
	assert.deepEqual(outputLinks, sourceLinks, "composition changed dependency symlink layout");
	for (const path of sourceLinks) {
		const sourceTarget = source.get(path)?.target;
		const outputTarget = output.get(path)?.target;
		assert.ok(sourceTarget !== undefined && outputTarget !== undefined, `missing dependency link target: ${path}`);
		assert.equal(outputTarget, expectedOutputLinkTarget(sourceTarget), `dependency link target changed: ${path}`);
	}
	await assertSymlinksConfined(COMPOSED_ROOT, output);

	const mainExtensions = [...source].filter(([path, entry]) => entry.kind === "file" && /^extensions\/[^/]+$/.test(path));
	assert.equal(mainExtensions.length, 12, "pinned main extension inventory changed");
	for (const path of ["package.json", "pnpm-lock.yaml", "lib/agent-home.ts", ".gentle-ai/v3.4.0/gentle-ai", ".gentle-ai/v3.4.0/integrity.json"]) {
		assert.equal(output.get(path)?.digest, source.get(path)?.digest, `composition changed protected main entry: ${path}`);
	}
	const overlayExtensionDetails = await lstat(join(CHECKOUT_ROOT, "extensions/ask-user-question.ts"));
	assert.ok(overlayExtensionDetails.isFile() && !overlayExtensionDetails.isSymbolicLink(), "owned extension overlay must be regular");
	assert.equal(output.get("extensions/ask-user-question.ts")?.digest, createHash("sha256").update(await readFile(join(CHECKOUT_ROOT, "extensions/ask-user-question.ts"))).digest("hex"), "owned extension bytes changed");
	const questions = await collectTree(join(CHECKOUT_ROOT, "lib/questions"));
	assert.ok(questions.size > 0, "questionnaire overlay must contain files");
	for (const [path, entry] of questions) {
		assert.equal(entry.kind, "file", `questionnaire overlay entry must be regular: ${path}`);
		assert.equal(output.get(join("lib/questions", path))?.digest, entry.digest, `questionnaire overlay bytes changed: ${path}`);
	}
	const expectedOverlayPaths = ["extensions/ask-user-question.ts", "lib/questions", ...[...questions.keys()].map((path) => join("lib/questions", path))].sort();
	const actualOverlayPaths = [...output.keys()].filter(overlayPath).sort();
	assert.deepEqual(actualOverlayPaths, expectedOverlayPaths, "composition changed the exact questionnaire overlay inventory");
	const archiveDigest = createHash("sha256").update(await readFile(join(ARTIFACT_ROOT, manifest.native.asset))).digest("hex");
	assert.equal(archiveDigest, manifest.native.assetSha256, "acquired native archive hash changed");
	assert.equal(source.get(".gentle-ai/v3.4.0/gentle-ai")?.digest, manifest.native.binarySha256, "acquired native binary hash changed");
	assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]), "", "composition mutated the acquired main checkout");
}

async function withScratch<T>(run: (root: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(join(tmpdir(), "qmc-02c-"));
	try {
		return await run(root);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

async function scratchFixture(root: string): Promise<ScratchFixture> {
	const fixture = { root, source: join(root, "source"), overlay: join(root, "overlay"), output: join(root, "output") };
	await mkdir(join(fixture.source, "extensions"), { recursive: true });
	await mkdir(join(fixture.overlay, "extensions"), { recursive: true });
	await mkdir(join(fixture.overlay, "lib/questions"), { recursive: true });
	await writeFile(join(fixture.source, "package.json"), "{\"name\":\"scratch-main\"}\n");
	await writeFile(join(fixture.overlay, "extensions/ask-user-question.ts"), "questionnaire-owned\n");
	await writeFile(join(fixture.overlay, "lib/questions/scratch.ts"), "export const scratch = true;\n");
	return fixture;
}

async function expectCompositionFailure(fixture: ScratchFixture, pattern: RegExp, sourceRoot = fixture.source): Promise<void> {
	let failure: unknown;
	try {
		await composeQuestionnaireMainArtifact({ sourceRoot, overlayRoot: fixture.overlay, outputRoot: fixture.output });
	} catch (error) {
		failure = error;
	}
	assert.ok(failure instanceof Error, "composition accepted an invalid overlay");
	assert.match(failure.message, pattern);
}

async function assertNoScratchFiles(output: string): Promise<void> {
	const entries = await collectTree(output);
	assert.deepEqual([...entries.keys()], [], "invalid composition copied entries before rejection");
}

test("hosted composition uses network-none read-only result isolation", () => {
	const expected = ["ACQUIRED_ARTIFACTS_ROOT", "ACQUIRED_MAIN_ROOT", "COMPOSED_ROOT", "GENTLE_PI_HOSTED_ISOLATION", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_SYSTEM", "GIT_OPTIONAL_LOCKS", "GIT_TERMINAL_PROMPT", "HOME", "NODE_TEST_WORKER_ID", "PATH", "TMPDIR"].sort();
	const actual = Object.keys(process.env).filter((key) => key !== "NODE_TEST_CONTEXT").sort();
	assert.deepEqual(actual, expected);
	assert.equal(process.env.GENTLE_PI_HOSTED_ISOLATION, "docker-network-none-readonly-v1");
	assert.equal(process.env.ACQUIRED_MAIN_ROOT, MAIN_ROOT);
	assert.equal(process.env.ACQUIRED_ARTIFACTS_ROOT, ARTIFACT_ROOT);
	assert.equal(process.env.COMPOSED_ROOT, COMPOSED_ROOT);
	assert.equal(process.getuid?.(), 1000);
	for (const mount of ["/", CHECKOUT_ROOT, MAIN_ROOT, ARTIFACT_ROOT, COMPOSED_ROOT]) assert.ok(mountOptions(mount).includes("ro"), `${mount} must be read-only`);
	const status = readFileSync("/proc/self/status", "utf8");
	assert.match(status, /^NoNewPrivs:\s+1$/m);
	assert.match(status, /^CapEff:\s+0+$/m);
	assert.deepEqual(Object.keys(networkInterfaces()).filter((name) => name !== "lo"), []);
	assert.deepEqual(Object.keys(process.env).filter((key) => /TOKEN|PASSWORD|SECRET|CREDENTIAL|AWS_|GITHUB_/i.test(key)), []);
});

test("composition preserves acquired bytes and adds only the questionnaire overlay", async () => {
	const before = await collectTree(MAIN_ROOT);
	await assertComposedArtifact();
	assert.deepEqual(await collectTree(MAIN_ROOT), before, "composition changed its acquired input");
});

test("composition rejects collisions before copying", async () => withScratch(async (root) => {
	// This minimal source is intentional: collision preflight must precede full-bundle validation.
	const fixture = await scratchFixture(root);
	await writeFile(join(fixture.source, "extensions/ask-user-question.ts"), "main-owned\n");
	await mkdir(join(fixture.overlay, "extensions"), { recursive: true });
	await writeFile(join(fixture.overlay, "extensions/ask-user-question.ts"), "questionnaire-owned\n");
	const before = await collectTree(fixture.source);
	await expectCompositionFailure(fixture, /collision/i);
	assert.deepEqual(await collectTree(fixture.source), before);
	await assertNoScratchFiles(fixture.output);
}));

test("composition rejects unexpected overlay entries before copying", async () => withScratch(async (root) => {
	const fixture = await scratchFixture(root);
	await writeFile(join(fixture.overlay, "README.md"), "not part of the questionnaire overlay\n");
	await expectCompositionFailure(fixture, /unexpected|overlay|allow/i, MAIN_ROOT);
	await assertNoScratchFiles(fixture.output);
}));

test("composition rejects nonregular overlay files before copying", async () => withScratch(async (root) => {
	const fixture = await scratchFixture(root);
	await rm(join(fixture.overlay, "extensions/ask-user-question.ts"));
	await mkdir(join(fixture.overlay, "extensions/ask-user-question.ts"), { recursive: true });
	await expectCompositionFailure(fixture, /regular|file|overlay/i, MAIN_ROOT);
	await assertNoScratchFiles(fixture.output);
}));

test("composition rejects overlay symlinks that escape confinement", async () => withScratch(async (root) => {
	const fixture = await scratchFixture(root);
	const outside = join(root, "outside.ts");
	await writeFile(outside, "outside\n");
	await symlink(outside, join(fixture.overlay, "lib/questions/escape.ts"));
	await expectCompositionFailure(fixture, /symlink|escape|confine/i, MAIN_ROOT);
	await assertNoScratchFiles(fixture.output);
}));

test("composition rejects acquired symlinks with external absolute targets", async () => withScratch(async (root) => {
	// This minimal source is intentional: source-link confinement must precede full-bundle validation.
	const fixture = await scratchFixture(root);
	const outside = join(root, "outside-dependency");
	await mkdir(join(fixture.source, "node_modules"), { recursive: true });
	await mkdir(outside, { recursive: true });
	await symlink(outside, join(fixture.source, "node_modules/external"));
	await expectCompositionFailure(fixture, /symlink|escape|confine|source/i);
	await assertNoScratchFiles(fixture.output);
}));
