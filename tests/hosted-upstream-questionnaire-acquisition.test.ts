import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
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
	trackedFileCount: number;
	questionnairePaths: string[];
	package: PackageShape;
	lock: { lockfileVersion: string; importer: LockEntry[] };
	installedPackages: Array<{ path: string; name: string; version: string }>;
};

const CHECKOUT_ROOT = "/workspace";
const UPSTREAM_ROOT = "/acquired-upstream";
const MANIFEST_PATH = join(CHECKOUT_ROOT, ".github/workflows/fixtures/hosted-upstream-questionnaire.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as Manifest;
const EXPECTED_COMMIT = "f2d9d073ffc2299eb501902753b42789f7cdc461";
const EXPECTED_TREE = "6fb42857f728f131da054e592ec5d22c691ce870";
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
	return line.split(" - ")[0]?.split(" ")[5]?.split(",") ?? [];
}

function git(args: string[]): string {
	return execFileSync(
		"git",
		["-c", "core.hooksPath=/dev/null", "-c", "diff.external=", "-c", "credential.helper=", "-C", UPSTREAM_ROOT, ...args],
		{ env: gitEnvironment, encoding: "utf8", maxBuffer: 256 * 1024 },
	).trim();
}

function trackedPaths(): string[] {
	return git(["ls-tree", "-r", "-z", "--full-tree", "HEAD"])
		.split("\0")
		.filter(Boolean)
		.map((record) => {
			const separator = record.indexOf("\t");
			assert.ok(separator >= 0, "Git tree record is malformed");
			const [mode, type, sha] = record.slice(0, separator).split(" ");
			assert.match(mode, /^\d+$/);
			assert.equal(type, "blob");
			assert.match(sha, /^[0-9a-f]{40}$/);
			return record.slice(separator + 1);
		});
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertImporter(lockText: string, entry: LockEntry): void {
	const key = entry.name.startsWith("@") ? `'${entry.name}'` : entry.name;
	const specifier = entry.specifier === "*" ? "'*'" : entry.specifier;
	const pattern = new RegExp(
		`^ {6}${escapeRegExp(key)}:\n` +
			` {8}specifier: ${escapeRegExp(specifier)}\n` +
			` {8}version: ([^\n]+)$`,
		"m",
	);
	const match = pattern.exec(lockText);
	assert.ok(match, `lock importer entry missing: ${entry.name}`);
	assert.ok(match[1]?.startsWith(entry.versionPrefix), `lock version changed: ${entry.name}`);
}

assert.equal(manifest.schema, "gentle-pi.hosted-upstream-questionnaire-acquisition/v1");
assert.equal(manifest.commit, EXPECTED_COMMIT);
assert.equal(manifest.tree, EXPECTED_TREE);
assert.deepEqual(manifest.questionnairePaths, [
	"extensions/ask-user-choice.ts",
	"extensions/ask-user-question.ts",
	"lib/questionnaire/questionnaire-view.ts",
	"lib/questionnaire/schema.ts",
	"lib/questionnaire/validate.ts",
	"tests/ask-user-choice.test.ts",
	"tests/ask-user-question.test.ts",
	"tests/questionnaire-schema.test.ts",
	"tests/questionnaire-view.test.ts",
]);
assert.equal(manifest.package.name, "gentle-pi");
assert.equal(manifest.package.version, "3.3.0");
assert.equal(manifest.package.packageManager, "pnpm@11.1.1");
assert.deepEqual(manifest.package.dependencies, {
	"@earendil-works/pi-tui": "0.85.1",
	"@heyhuynhgiabuu/pi-pretty": "0.6.27",
});
assert.deepEqual(manifest.package.peerDependencies, {
	"@earendil-works/pi-coding-agent": ">=0.85.1",
	typebox: "*",
});

test("hosted upstream acquisition uses bounded offline isolation", () => {
	const expected = [
		"ACQUIRED_UPSTREAM_ROOT",
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
	const actual = Object.keys(process.env).filter((key) => key !== "NODE_TEST_CONTEXT").sort();
	assert.deepEqual(actual, expected);
	assert.deepEqual(Object.keys(process.env).filter((key) => /TOKEN|PASSWORD|SECRET|CREDENTIAL|AWS_|GITHUB_/i.test(key)), []);
	assert.equal(process.env.ACQUIRED_UPSTREAM_ROOT, UPSTREAM_ROOT);
	assert.equal(process.env.GENTLE_PI_HOSTED_ISOLATION, "docker-network-none-readonly-v1");
	assert.equal(process.getuid?.(), 1000);
	for (const mount of ["/", CHECKOUT_ROOT, UPSTREAM_ROOT]) assert.ok(mountOptions(mount).includes("ro"), `${mount} must be read-only`);
	const status = readFileSync("/proc/self/status", "utf8");
	assert.match(status, /^NoNewPrivs:\s+1$/m);
	assert.match(status, /^CapEff:\s+0+$/m);
	assert.deepEqual(Object.keys(networkInterfaces()).filter((name) => name !== "lo"), []);
	console.log("artifact-proof isolation=network-none,root-ro,checkout-ro,upstream-ro,uid=1000,caps=0,no-new-privs=1");
});

test("hosted upstream acquisition preserves exact source and dependency identity", async () => {
	assert.equal(git(["rev-parse", "HEAD"]), EXPECTED_COMMIT);
	assert.equal(git(["rev-parse", "HEAD^{tree}"]), EXPECTED_TREE);
	const paths = trackedPaths();
	assert.equal(paths.length, manifest.trackedFileCount);
	assert.deepEqual(paths.filter((path) => manifest.questionnairePaths.includes(path)), manifest.questionnairePaths);
	assert.equal(git(["status", "--porcelain=v1", "--untracked-files=all"]), "");
	assert.equal(await lstat(join(UPSTREAM_ROOT, ".gentle-ai")).catch(() => undefined), undefined);

	const packageJson = JSON.parse(await readFile(join(UPSTREAM_ROOT, "package.json"), "utf8")) as PackageShape;
	assert.equal(packageJson.name, manifest.package.name);
	assert.equal(packageJson.version, manifest.package.version);
	assert.equal(packageJson.packageManager, manifest.package.packageManager);
	assert.deepEqual(packageJson.dependencies, manifest.package.dependencies);
	assert.deepEqual(packageJson.peerDependencies, manifest.package.peerDependencies);
	assert.deepEqual(packageJson.devDependencies, manifest.package.devDependencies);
	const lockText = await readFile(join(UPSTREAM_ROOT, "pnpm-lock.yaml"), "utf8");
	assert.match(lockText, /^lockfileVersion: ['"]?9\.0['"]?$/m);
	for (const entry of manifest.lock.importer) assertImporter(lockText, entry);
	for (const entry of manifest.installedPackages) {
		const metadata = JSON.parse(await readFile(join(UPSTREAM_ROOT, entry.path), "utf8")) as { name?: string; version?: string };
		assert.equal(metadata.name, entry.name, `installed metadata name changed: ${entry.name}`);
		assert.equal(metadata.version, entry.version, `installed metadata version changed: ${entry.name}`);
	}
	console.log(`artifact-proof repository=${EXPECTED_COMMIT} tree=${EXPECTED_TREE} tracked-files=${paths.length} pnpm=11.1.1 frozen-lockfile=true scripts=false native=false`);
});
