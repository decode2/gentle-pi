import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

export const frozenModules = {
	"extensions/ask-user-question.ts": "ad0e38e63635d4b68067378370ea3c968dca4eb3",
	"lib/agent-home.ts": "085302a82d423907b1b33257704895bbfef8281d",
	"lib/native-fullscreen-interaction.ts": "58464b5d1d9c24653e18caa4a9a07656f0d7d568",
	"lib/questionnaire/schema.ts": "13913bd6d1eac5650ca483f6ed687b4a67b5769f",
	"lib/questionnaire/questionnaire-view.ts": "61284f0110522f2e65a43271f9e23f5bfe350a72",
	"lib/questionnaire/validate.ts": "5bf7d031bf9338b204cd69cbba0b197706721f2b",
	"lib/rpc-host.ts": "5248b2bb0821169ac7898ec8574ca961f61e1450",
	"lib/terminal-theme.ts": "f62b8eb3502fd1ca70121e9dead850f5564faf14",
} as const;

export interface PackReport {
	filename: string;
	integrity: string;
	size: number;
	files: { path: string; size: number }[];
}
export interface PackedArtifact { archivePath: string; report: PackReport }

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function regularContainedFile(root: string, relative: string): Buffer {
	const path = join(root, relative);
	assert.ok(existsSync(path), `packed member missing: ${relative}`);
	assert.ok(lstatSync(path).isFile(), `packed member not regular: ${relative}`);
	assert.ok(realpathSync(path).startsWith(realpathSync(root) + sep), `packed member outside root: ${relative}`);
	return readFileSync(path);
}

export function verifyIntegrity(bytes: Buffer, report: PackReport): void {
	const actual = "sha512-" + createHash("sha512").update(bytes).digest("base64");
	assert.equal(actual, report.integrity, "packed archive SHA-512 integrity mismatch");
	assert.equal(bytes.length, report.size, "packed archive size mismatch");
}

// Explicit invocation only: importing this fixture performs no artifact I/O.
export function loadArtifact(directory: string): PackedArtifact {
	const root = realpathSync(directory);
	const reports: unknown = JSON.parse(regularContainedFile(root, "pack.json").toString("utf8"));
	assert.ok(Array.isArray(reports) && reports.length === 1, "expected one npm pack report");
	const report: unknown = reports[0];
	assert.ok(isRecord(report), "invalid npm pack report");
	assert.equal(report.name, "gentle-pi");
	assert.equal(report.version, "4.0.0");
	assert.equal(typeof report.filename, "string");
	assert.ok(typeof report.filename === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.tgz$/.test(report.filename), "unsafe archive filename");
	assert.ok(typeof report.integrity === "string" && /^sha512-[A-Za-z0-9+/]+={0,2}$/.test(report.integrity), "invalid npm integrity");
	assert.ok(typeof report.size === "number" && Number.isSafeInteger(report.size) && report.size > 0);
	assert.ok(Array.isArray(report.files), "missing npm pack members");
	const files = report.files.map((member: unknown) => {
		assert.ok(isRecord(member) && typeof member.path === "string" && typeof member.size === "number", "invalid npm pack member");
		assert.ok(!member.path.startsWith("/") && !member.path.includes("\\") && member.path.split("/").every((part) => part !== ".." && part !== ""), "unsafe npm member path");
		assert.ok(Number.isSafeInteger(member.size) && member.size >= 0);
		return { path: member.path, size: member.size };
	});
	const parsed = { filename: report.filename, integrity: report.integrity, size: report.size, files };
	const archivePath = join(root, parsed.filename);
	verifyIntegrity(regularContainedFile(root, parsed.filename), parsed);
	return { archivePath, report: parsed };
}

export function extractArtifact(artifact: PackedArtifact, destination: string): void {
	verifyIntegrity(readFileSync(artifact.archivePath), artifact.report);
	mkdirSync(destination);
	// Trusted exact-SHA pack, extracted only into a fresh sandbox-owned directory.
	// This is not a general-purpose hostile archive sanitizer.
	execFileSync("tar", ["-xzf", artifact.archivePath, "--strip-components=1", "--no-same-owner", "-C", destination], {
		timeout: 30_000, maxBuffer: 1024 * 1024, stdio: "pipe",
	});
}

export function gitBlob(bytes: Buffer): string {
	return createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}

export function verifyExtraction(root: string, report: PackReport): void {
	for (const relative of ["package.json", ...Object.keys(frozenModules)]) {
		const members = report.files.filter((member) => member.path === relative);
		assert.equal(members.length, 1, `npm member count: ${relative}`);
		const bytes = regularContainedFile(root, relative);
		assert.equal(bytes.length, members[0].size, `npm member size: ${relative}`);
		if (relative !== "package.json") {
			const expected = frozenModules[relative as keyof typeof frozenModules];
			assert.equal(gitBlob(bytes), expected, `packed Git blob mismatch: ${relative}`);
		}
	}
	// Check required semantics, not npm's unspecified JSON byte normalization.
	const manifest: unknown = JSON.parse(regularContainedFile(root, "package.json").toString("utf8"));
	assert.ok(isRecord(manifest));
	assert.equal(manifest.name, "gentle-pi");
	assert.equal(manifest.version, "4.0.0");
	assert.ok(isRecord(manifest.pi));
	assert.deepEqual(manifest.pi.extensions, ["./extensions"]);
	assert.ok(Array.isArray(manifest.files));
	for (const path of ["extensions/", "lib/", "scripts/"]) assert.ok(manifest.files.includes(path));
	// Host-provided dependencies are peers, not physical runtime dependencies.
	assert.ok(isRecord(manifest.peerDependencies) && isRecord(manifest.dependencies) && isRecord(manifest.devDependencies));
	assert.equal(manifest.peerDependencies["@earendil-works/pi-coding-agent"], ">=0.99.1");
	assert.equal(manifest.peerDependencies.typebox, "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-ai"], "*");
	assert.equal(manifest.peerDependencies["@earendil-works/pi-tui"], "*");
	for (const dependency of [
		"@earendil-works/pi-ai", "@earendil-works/pi-agent-core",
		"@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "typebox",
	]) assert.ok(!Object.prototype.hasOwnProperty.call(manifest.dependencies, dependency), `physical host dependency: ${dependency}`);
	assert.equal(manifest.devDependencies["@earendil-works/pi-coding-agent"], ">=1.0.0");
	assert.equal(manifest.devDependencies["@earendil-works/pi-ai"], ">=1.0.0");
	assert.equal(manifest.devDependencies["@earendil-works/pi-tui"], ">=1.0.0");
}
