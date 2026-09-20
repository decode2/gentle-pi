import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readFile, realpath } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import test from "node:test";

type PackageShape = {
	name: string;
	version: string;
	packageManager: string;
	dependencies: Record<string, string>;
	peerDependencies: Record<string, string>;
	devDependencies: Record<string, string>;
};
type LockEntry = { name: string; specifier: string; versionPrefix: string };
type NativeShape = {
	version: string;
	asset: string;
	url: string;
	assetSha256: string;
	binarySha256: string;
	member: string;
};
type Manifest = {
	schema: string;
	repository: string;
	commit: string;
	tree: string;
	package: PackageShape;
	lock: { lockfileVersion: string; importer: LockEntry[] };
	installedPackages: Array<{ path: string; name: string; version: string }>;
	native: NativeShape;
};
type ProvenanceFile = { path: string; mode: string; sha: string };
type Provenance = { repository: string; commit: string; tree: string; files: ProvenanceFile[] };

const CHECKOUT_ROOT = "/workspace";
const MAIN_ROOT = "/acquired-main";
const ARTIFACT_ROOT = "/acquired-artifacts";
const NATIVE_VERSION = "3.4.0";
const NATIVE_ROOT = join(MAIN_ROOT, ".gentle-ai");
const NATIVE_VERSION_ROOT = join(NATIVE_ROOT, `v${NATIVE_VERSION}`);
const NATIVE_BINARY = join(NATIVE_VERSION_ROOT, "gentle-ai");
const NATIVE_MANIFEST = join(NATIVE_VERSION_ROOT, "integrity.json");
const MANIFEST_PATH = join(
	CHECKOUT_ROOT,
	".github/workflows/fixtures/questionnaire-main-acquisition.json",
);
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const gitEnvironment = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_SYSTEM: "/dev/null",
	GIT_OPTIONAL_LOCKS: "0",
	GIT_TERMINAL_PROMPT: "0",
};

function mountOptions(point: string): string[] {
	const line = readFileSync("/proc/self/mountinfo", "utf8")
		.split("\n")
		.find((candidate) => candidate.split(" - ")[0]?.split(" ")[4] === point);
	assert.ok(line, `missing mount readback for ${point}`);
	const fields = line.split(" - ")[0]?.split(" ");
	assert.ok(fields);
	return fields[5]?.split(",") ?? [];
}

function git(args: string[]): string {
	return execFileSync(
		"git",
		[
			"-c",
			"core.hooksPath=/dev/null",
			"-c",
			"diff.external=",
			"-c",
			"credential.helper=",
			"-C",
			MAIN_ROOT,
			...args,
		],
		{ env: gitEnvironment, encoding: "utf8" },
	).trim();
}

function treeRecord(record: string): ProvenanceFile {
	const separator = record.indexOf("\t");
	assert.notEqual(separator, -1, "Git tree record is malformed");
	const [mode, type, sha] = record.slice(0, separator).split(" ");
	assert.equal(type, "blob");
	assert.ok(mode && sha);
	return { path: record.slice(separator + 1), mode, sha };
}

function assertManifestShape(): void {
	assert.deepEqual(Object.keys(manifest).sort(), [
		"commit",
		"lock",
		"native",
		"package",
		"repository",
		"schema",
		"tree",
		"installedPackages",
	].sort());
	assert.equal(manifest.schema, "gentle-pi.hosted-main-acquisition/v1");
	assert.equal(
		manifest.repository,
		"https://github.com/Gentleman-Programming/gentle-shell.git",
	);
	assert.match(manifest.commit, /^[0-9a-f]{40}$/);
	assert.match(manifest.tree, /^[0-9a-f]{40}$/);
	assert.equal(manifest.package.packageManager, "pnpm@11.1.1");
	assert.deepEqual(Object.keys(manifest.native), [
		"version",
		"asset",
		"url",
		"assetSha256",
		"binarySha256",
		"member",
	]);
	assert.deepEqual(manifest.native, {
		version: "3.4.0",
		asset: "gentle-ai_3.4.0_linux_amd64.tar.gz",
		url: "https://github.com/Gentleman-Programming/gentle-ai/releases/download/v3.4.0/gentle-ai_3.4.0_linux_amd64.tar.gz",
		assetSha256: "c287289a514420381e890991bb3fbea4a2c36d7b4b1774fcf6bc4deb83378915",
		binarySha256: "309d9aafb48de5ef90ba0a212e8a98e8fdbb82d0852e24015e36a5ce0fe04c06",
		member: "gentle-ai",
	});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertImporter(lockText: string, entry: LockEntry): void {
	const key = entry.name.startsWith("@") ? `'${entry.name}'` : entry.name;
	const specifier = entry.specifier === "*" ? "'*'" : entry.specifier;
	const pattern = new RegExp(
		`^ {6}${escapeRegExp(key)}:\\n` +
			` {8}specifier: ${escapeRegExp(specifier)}\\n` +
			` {8}version: ([^\\n]+)$`,
		"m",
	);
	const match = pattern.exec(lockText);
	assert.ok(match, `lock importer entry missing: ${entry.name}`);
	assert.ok(match[1]?.startsWith(entry.versionPrefix), `lock version changed: ${entry.name}`);
}

assertManifestShape();

test("hosted acquisition uses the bounded offline isolation contract", () => {
	const expected = [
		"ACQUIRED_ARTIFACTS_ROOT",
		"ACQUIRED_MAIN_ROOT",
		"GENTLE_PI_HOSTED_ISOLATION",
		"GIT_CONFIG_GLOBAL",
		"GIT_CONFIG_NOSYSTEM",
		"GIT_CONFIG_SYSTEM",
		"GIT_OPTIONAL_LOCKS",
		"GIT_TERMINAL_PROMPT",
		"HOME",
		"NODE_TEST_WORKER_ID",
		"PATH",
		"TMPDIR",
	].sort();
	const actual = Object.keys(process.env)
		.filter((key) => key !== "NODE_TEST_CONTEXT")
		.sort();
	assert.deepEqual(actual, expected);
	assert.equal(process.env.NODE_TEST_WORKER_ID, "1");
	assert.deepEqual(
		Object.keys(process.env).filter((key) => /TOKEN|PASSWORD|SECRET|CREDENTIAL|AWS_|GITHUB_/i.test(key)),
		[],
	);
	assert.equal(process.env.ACQUIRED_MAIN_ROOT, MAIN_ROOT);
	assert.equal(process.env.ACQUIRED_ARTIFACTS_ROOT, ARTIFACT_ROOT);
	assert.equal(process.env.GENTLE_PI_HOSTED_ISOLATION, "docker-network-none-readonly-v1");
	assert.equal(process.getuid?.(), 1000);
	for (const mount of ["/", CHECKOUT_ROOT, MAIN_ROOT, ARTIFACT_ROOT]) {
		assert.ok(mountOptions(mount).includes("ro"), `${mount} must be read-only`);
	}
	const status = readFileSync("/proc/self/status", "utf8");
	assert.match(status, /^NoNewPrivs:\s+1$/m);
	assert.match(status, /^CapEff:\s+0+$/m);
	assert.deepEqual(Object.keys(networkInterfaces()).filter((name) => name !== "lo"), []);
	console.log("artifact-proof isolation=network-none,root-ro,checkout-ro,main-ro,artifacts-ro,uid=1000,caps=0,no-new-privs=1");
});

test("hosted acquisition preserves the pinned Git tree and tracked cleanliness", async () => {
	const provenance = JSON.parse(
		await readFile(join(ARTIFACT_ROOT, "main-provenance.json"), "utf8"),
	) as Provenance;
	assert.deepEqual(Object.keys(provenance).sort(), ["commit", "files", "repository", "tree"]);
	const head = git(["rev-parse", "HEAD"]);
	const tree = git(["rev-parse", "HEAD^{tree}"]);
	assert.equal(head, manifest.commit);
	assert.equal(tree, manifest.tree);
	assert.equal(provenance.repository, manifest.repository);
	assert.equal(provenance.commit, head);
	assert.equal(provenance.tree, tree);
	const records = git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
		.split("\0")
		.filter(Boolean)
		.map(treeRecord);
	assert.deepEqual(provenance.files, records);
	assert.ok(records.length > 0);
	assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
	assert.equal(git(["diff", "--no-ext-diff", "--exit-code", "HEAD", "--"]), "");
	assert.equal(git(["diff", "--cached", "--no-ext-diff", "--exit-code"]), "");
	assert.equal(records.some((file) => file.path === "extensions/ask-user-question.ts"), false);
	assert.equal(records.some((file) => file.path === "lib/questions" || file.path.startsWith("lib/questions/")), false);
	assert.equal(records.some((file) => file.path === ".gentle-ai" || file.path.startsWith(".gentle-ai/")), false);
	console.log(`artifact-proof repository=${head} tree=${tree} tracked-files=${records.length}`);
});

test("hosted acquisition preserves exact main package, lock, and selected metadata", async () => {
	const packageJson = JSON.parse(
		await readFile(join(MAIN_ROOT, "package.json"), "utf8"),
	) as PackageShape;
	assert.equal(packageJson.name, manifest.package.name);
	assert.equal(packageJson.version, manifest.package.version);
	assert.equal(packageJson.packageManager, manifest.package.packageManager);
	assert.deepEqual(packageJson.dependencies, manifest.package.dependencies);
	assert.deepEqual(packageJson.peerDependencies, manifest.package.peerDependencies);
	assert.deepEqual(packageJson.devDependencies, manifest.package.devDependencies);
	const lockText = await readFile(join(MAIN_ROOT, "pnpm-lock.yaml"), "utf8");
	assert.match(lockText, /^lockfileVersion: ['"]?9\.0['"]?$/m);
	for (const entry of manifest.lock.importer) {
		assertImporter(lockText, entry);
	}
	for (const entry of manifest.installedPackages) {
		const metadata = JSON.parse(
			await readFile(join(MAIN_ROOT, entry.path), "utf8"),
		) as { name?: string; version?: string };
		assert.equal(metadata.name, entry.name, `installed metadata name changed: ${entry.name}`);
		assert.equal(metadata.version, entry.version, `installed metadata version changed: ${entry.name}`);
	}
	console.log(`artifact-proof package=${packageJson.name}@${packageJson.version} pnpm=${packageJson.packageManager} lock=${manifest.lock.lockfileVersion} selected-installed-metadata=${manifest.installedPackages.length}`);
});

test("hosted native artifact preserves exact release hashes and canonical integrity", async () => {
	const archiveSha256 = createHash("sha256")
		.update(await readFile(join(ARTIFACT_ROOT, manifest.native.asset)))
		.digest("hex");
	const binarySha256 = createHash("sha256")
		.update(await readFile(NATIVE_BINARY))
		.digest("hex");
	assert.equal(archiveSha256, manifest.native.assetSha256);
	assert.equal(binarySha256, manifest.native.binarySha256);
	const expected = {
		version: manifest.native.version,
		asset: manifest.native.asset,
		assetSha256: manifest.native.assetSha256,
		binarySha256: manifest.native.binarySha256,
	};
	const contents = await readFile(NATIVE_MANIFEST, "utf8");
	assert.equal(contents, `${JSON.stringify(expected)}\n`);
	const parsed = JSON.parse(contents) as Record<string, string>;
	assert.deepEqual(Object.keys(parsed), ["version", "asset", "assetSha256", "binarySha256"]);
	assert.deepEqual(parsed, expected);
	console.log(`native-artifact-proof archiveSha256=${archiveSha256} binarySha256=${binarySha256} manifest=canonical-ordered`);
});

test("hosted native artifact is regular executable and confined to ignored main runtime path", async () => {
	for (const [path, label] of [
		[MAIN_ROOT, "main root"],
		[NATIVE_ROOT, "native root"],
		[NATIVE_VERSION_ROOT, "native version directory"],
	]) {
		const details = await lstat(path);
		assert.ok(details.isDirectory(), `${label} must be a directory`);
		assert.equal(details.isSymbolicLink(), false, `${label} must not be a symlink`);
	}
	for (const [path, label] of [
		[join(ARTIFACT_ROOT, manifest.native.asset), "native archive"],
		[NATIVE_BINARY, "native binary"],
		[NATIVE_MANIFEST, "native integrity manifest"],
	]) {
		const details = await lstat(path);
		assert.ok(details.isFile(), `${label} must be a regular file`);
		assert.equal(details.isSymbolicLink(), false, `${label} must not be a symlink`);
		if (label === "native binary") assert.notEqual(details.mode & 0o111, 0, "native binary must be executable");
	}
	const mainReal = await realpath(MAIN_ROOT);
	const artifactReal = await realpath(ARTIFACT_ROOT);
	for (const [path, parent, label] of [
		[await realpath(NATIVE_ROOT), mainReal, "native root"],
		[await realpath(NATIVE_VERSION_ROOT), mainReal, "native version directory"],
		[await realpath(NATIVE_BINARY), mainReal, "native binary"],
		[await realpath(NATIVE_MANIFEST), mainReal, "native integrity manifest"],
		[await realpath(join(ARTIFACT_ROOT, manifest.native.asset)), artifactReal, "native archive"],
	]) {
		const child = relative(parent, path);
		assert.notEqual(child, "", `${label} must be below its parent`);
		assert.equal(isAbsolute(child), false, `${label} escaped its parent`);
		assert.equal(child.startsWith(".."), false, `${label} escaped its parent`);
	}
	const mainGitignore = await readFile(join(MAIN_ROOT, ".gitignore"), "utf8");
	assert.match(mainGitignore, /(?:^|\r?\n)\.gentle-ai\/(?:\r?\n|$)/);
	console.log("native-artifact-proof layout=.gentle-ai/v3.4.0 regular=true executable=true confined=true main-gitignore=true");
});
