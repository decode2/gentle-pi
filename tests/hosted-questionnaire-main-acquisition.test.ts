import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
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
type Manifest = {
	schema: string;
	repository: string;
	commit: string;
	tree: string;
	package: PackageShape;
	lock: { lockfileVersion: string; importer: LockEntry[] };
	installedPackages: Array<{ path: string; name: string; version: string }>;
};
type ProvenanceFile = { path: string; mode: string; sha: string };
type Provenance = { repository: string; commit: string; tree: string; files: ProvenanceFile[] };

const CHECKOUT_ROOT = "/workspace";
const MAIN_ROOT = "/acquired-main";
const ARTIFACT_ROOT = "/acquired-artifacts";
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
