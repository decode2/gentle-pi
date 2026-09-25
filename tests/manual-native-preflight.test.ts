import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as preflight from "../scripts/manual-native-preflight.mjs";
import {
	ENGRAM_CHECKSUMS_SHA256,
	ENGRAM_RELEASE_ASSETS,
	GENTLE_PI_NPM_SRI,
	PI_NPM_SRI,
	resolveEngramReleaseAsset,
	resolveScratchDirectory,
	verifyEngramArtifacts,
	verifyNpmIntegrity,
} from "../scripts/manual-native-preflight.mjs";

// Pure artifact-preflight tests only: they never install packages or run
// postinstall, setup, or the launcher, and make no runtime/Ready claim.
const darwinArm = "engram_2.1.0_darwin_arm64.tar.gz";
const darwinArmSha = "b9167999ba6deca652e367bd7d44766afa33430ab93b01f7cc0be42e6364d806";
const windowsX64 = "engram_2.1.0_windows_amd64.zip";
const windowsX64Sha = "342ace84c1a716c5e6cd969ed92fe63c8b00304cd8bd1bd6455247db4f9afc9c";
const checksumText = `${darwinArmSha}  ${darwinArm}\n${windowsX64Sha}  ${windowsX64}\n`;

test("scoped Pi npm pack archive uses the scope-prefixed filename", () => {
	assert.equal(preflight.PI_NPM_ARCHIVE_NAME, "earendil-works-pi-coding-agent-0.85.1.tgz");
});

function release() {
	return {
		tag_name: "v2.1.0",
		draft: false,
		prerelease: false,
		assets: [
			{ name: "checksums.txt", digest: `sha256:${ENGRAM_CHECKSUMS_SHA256}` },
			{ name: darwinArm, digest: `sha256:${darwinArmSha}` },
		],
	};
}

test("published npm pins use the exact registry SRI and reject changed bytes", () => {
	assert.equal(GENTLE_PI_NPM_SRI, "sha512-SXBp9jIRnVIcOsLCW/Zw4XDTXxhViXNxrCZS7LyioB6kdRl99Ohojeaj+yIH5+K/ucwLlTlHYBz8zwue9aspNQ==");
	assert.equal(PI_NPM_SRI, "sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==");
	const bytes = Buffer.from("staged archive");
	const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	assert.equal(verifyNpmIntegrity(bytes, integrity), true);
	assert.throws(() => verifyNpmIntegrity(Buffer.from("changed"), integrity), /integrity mismatch/);
	assert.throws(() => verifyNpmIntegrity(bytes, ""), /invalid integrity/);
});

test("Engram selection admits only pinned native OS and architecture assets", () => {
	assert.deepEqual(resolveEngramReleaseAsset("darwin", "arm64"), { name: darwinArm, sha256: darwinArmSha });
	assert.deepEqual(resolveEngramReleaseAsset("win32", "x64"), { name: windowsX64, sha256: windowsX64Sha });
	assert.deepEqual(resolveEngramReleaseAsset("darwin", "x64"), { name: "engram_2.1.0_darwin_amd64.tar.gz", sha256: "2c8f56f36c6779b1c0f5f56bf9339ed121192218272e4fc144a8ad7bed2da22c" });
	assert.deepEqual(resolveEngramReleaseAsset("win32", "arm64"), { name: "engram_2.1.0_windows_arm64.zip", sha256: "cdd2ec6e718140cb2d67e0170151baecba63fdcbaa09ef23107459aa2cce695e" });
	assert.throws(() => resolveEngramReleaseAsset("linux", "x64"), /unsupported platform\/architecture/);
	assert.throws(() => resolveEngramReleaseAsset("win32", "ia32"), /unsupported platform\/architecture/);
});

test("scratch path requires a non-empty absolute runner temp without traversal", () => {
	const runnerTemp = join(tmpdir(), "runner", "_temp");
	assert.equal(resolveScratchDirectory(runnerTemp), join(resolve(runnerTemp), "gentle-shell-manual-native-preflight"));
	assert.throws(() => resolveScratchDirectory(""), /unsafe scratch root/);
	assert.throws(() => resolveScratchDirectory("relative/temp"), /unsafe scratch root/);
	assert.throws(() => resolveScratchDirectory(tmpdir()), /unsafe scratch root/);
	assert.throws(() => resolveScratchDirectory(`${runnerTemp}${sep}..${sep}home`), /unsafe scratch root/);
});

test("Engram archive must agree with pinned release API digests and exact checksum row", () => {
	const selected = resolveEngramReleaseAsset("darwin", "arm64");
	assert.equal(verifyEngramArtifacts({
		release: release(),
		checksumText,
		checksumSha256: ENGRAM_CHECKSUMS_SHA256,
		archiveSha256: selected.sha256,
		platform: "darwin",
		architecture: "arm64",
	}), selected.name);

	const drifted = release();
	drifted.tag_name = "v2.1.1";
	assert.throws(() => verifyEngramArtifacts({ release: drifted, checksumText, checksumSha256: ENGRAM_CHECKSUMS_SHA256, archiveSha256: selected.sha256, platform: "darwin", architecture: "arm64" }), /release drift/);
	const missingDigest = release();
	missingDigest.assets[1].digest = undefined;
	assert.throws(() => verifyEngramArtifacts({ release: missingDigest, checksumText, checksumSha256: ENGRAM_CHECKSUMS_SHA256, archiveSha256: selected.sha256, platform: "darwin", architecture: "arm64" }), /missing official digest/);
	const changedDigest = release();
	changedDigest.assets[1].digest = `sha256:${"0".repeat(64)}`;
	assert.throws(() => verifyEngramArtifacts({ release: changedDigest, checksumText, checksumSha256: ENGRAM_CHECKSUMS_SHA256, archiveSha256: selected.sha256, platform: "darwin", architecture: "arm64" }), /release drift/);
	assert.throws(() => verifyEngramArtifacts({ release: release(), checksumText, checksumSha256: "0".repeat(64), archiveSha256: selected.sha256, platform: "darwin", architecture: "arm64" }), /checksum file digest mismatch/);
	assert.throws(() => verifyEngramArtifacts({ release: release(), checksumText: `${windowsX64Sha}  ${windowsX64}\n`, checksumSha256: ENGRAM_CHECKSUMS_SHA256, archiveSha256: selected.sha256, platform: "darwin", architecture: "arm64" }), /missing or invalid checksum row/);
});

const failure = async (operation) => {
	const result = await Promise.allSettled([operation()]);
	assert.equal(result[0].status, "rejected", "expected the operation to fail closed");
	return result[0].reason;
};

function mockResponse(status, { body = [], headers = {}, stream } = {}) {
	return {
		ok: status >= 200 && status < 300,
		status,
		headers: { get: (name) => headers[name.toLowerCase()] ?? null },
		body: stream ?? (async function* () { for (const chunk of body) yield chunk; })(),
	};
}

test("native fetch diagnostics use fixed stage and HTTP reason codes", async () => {
	const releaseForbidden = await failure(() => preflight.responseBytes("https://sentinel.invalid/release", 16, "release", async () => mockResponse(403)));
	assert.equal(preflight.safeFailureCode(releaseForbidden), "release-metadata-fetch-forbidden");

	const checksumsLimited = await failure(() => preflight.responseBytes("https://sentinel.invalid/checksums", 16, "checksums", async () => mockResponse(429)));
	assert.equal(preflight.safeFailureCode(checksumsLimited), "checksums-fetch-rate-limited");

	const archiveServerError = await failure(() => preflight.responseBytes("https://sentinel.invalid/archive", 16, "archive", async () => mockResponse(503)));
	assert.equal(preflight.safeFailureCode(archiveServerError), "native-archive-fetch-server-error");

	const releaseRateHeader = await failure(() => preflight.responseBytes("https://sentinel.invalid/release", 16, "release", async () => mockResponse(403, { headers: { "x-ratelimit-remaining": "0" } })));
	assert.equal(preflight.safeFailureCode(releaseRateHeader), "release-metadata-fetch-rate-limited");

	const otherStatus = await failure(() => preflight.responseBytes("https://sentinel.invalid/release", 16, "release", async () => mockResponse(418)));
	assert.equal(preflight.safeFailureCode(otherStatus), "release-metadata-fetch-http-status");
});

test("transport and oversized responses are distinct fixed fetch failures", async () => {
	const transport = await failure(() => preflight.responseBytes("https://sentinel.invalid/archive", 16, "archive", async () => { throw new Error("RAW_EXCEPTION_SENTINEL"); }));
	assert.equal(preflight.safeFailureCode(transport), "native-archive-fetch-transport");
	const oversized = await failure(() => preflight.responseBytes("https://sentinel.invalid/checksums", 2, "checksums", async () => mockResponse(200, { body: [Buffer.from("too large")] })));
	assert.equal(preflight.safeFailureCode(oversized), "checksums-fetch-response-too-large");
});

test("invalid fetch responses and content-length overflow use fixed stage codes", async () => {
	const invalidResponse = await failure(() => preflight.responseBytes("https://sentinel.invalid/release", 16, "release", async () => ({ ok: true, status: 200 })));
	assert.equal(preflight.safeFailureCode(invalidResponse), "release-metadata-fetch-invalid-response");

	const invalidChunk = await failure(() => preflight.responseBytes("https://sentinel.invalid/checksums", 16, "checksums", async () => mockResponse(200, { body: ["not bytes"] })));
	assert.equal(preflight.safeFailureCode(invalidChunk), "checksums-fetch-invalid-response");

	let bodyRead = false;
	const contentLengthOverflow = await failure(() => preflight.responseBytes("https://sentinel.invalid/archive", 2, "archive", async () => mockResponse(200, {
		headers: { "content-length": "3" },
		stream: (async function* () { bodyRead = true; yield Buffer.from("abc"); })(),
	})));
	assert.equal(preflight.safeFailureCode(contentLengthOverflow), "native-archive-fetch-response-too-large");
	assert.equal(bodyRead, false);
});

test("stream errors are attributed to their current fetch stage", async () => {
	const sentinel = "RAW_STREAM_URL_AND_ERROR_SENTINEL";
	const raw = new Error(`stream failed at https://${sentinel}.invalid`);
	const transport = await failure(() => preflight.responseBytes(`https://${sentinel}.invalid`, 16, "checksums", async () => mockResponse(200, {
		stream: (async function* () { throw raw; })(),
	})));
	assert.equal(preflight.safeFailureCode(transport), "checksums-fetch-transport");

	const foreignBrandedError = await failure(() => preflight.responseBytes("https://sentinel.invalid/checksums", 16, "checksums", async () => mockResponse(200, { body: ["not bytes"] })));
	const reattributed = await failure(() => preflight.responseBytes("https://sentinel.invalid/archive", 16, "archive", async () => mockResponse(200, {
		stream: (async function* () { throw foreignBrandedError; })(),
	})));
	assert.equal(preflight.safeFailureCode(reattributed), "native-archive-fetch-transport");
	assert.equal(preflight.formatPreflightFailure(reattributed).includes(sentinel), false);
});

test("CLI invalid-argument output contains only the fixed failure category", () => {
	const sentinel = "RAW_ARG_SENTINEL";
	const cliPath = fileURLToPath(new URL("../scripts/manual-native-preflight.mjs", import.meta.url));
	const child = spawnSync(process.execPath, [cliPath, sentinel], { encoding: "utf8", env: { PATH: "", HOME: "" } });
	assert.equal(child.status, 1);
	assert.equal(child.stdout, "");
	assert.equal(child.stderr, "Artifact preflight failed closed (unknown); no package was installed and postinstall, setup, or launcher was run.\n");
	assert.equal(child.stderr.includes(sentinel), false);
});

test("staged npm and release integrity failures have bounded public categories", () => {
	assert.equal(preflight.safeFailureCode(failureSync(() => preflight.verifyStagedNpmArchives(Buffer.from("changed"), Buffer.from("changed")))), "staged-npm-read-or-digest");
	const selected = resolveEngramReleaseAsset("darwin", "arm64");
	const changed = release();
	changed.tag_name = "v9.9.9";
	assert.equal(preflight.safeFailureCode(failureSync(() => preflight.verifyPinnedEngramArtifacts({ release: changed, checksumText, checksumSha256: ENGRAM_CHECKSUMS_SHA256, archiveSha256: selected.sha256, platform: "darwin", architecture: "arm64" }))), "release-digest-checksum-mismatch");
});

function failureSync(operation) {
	try { operation(); } catch (error) { return error; }
	assert.fail("expected the operation to fail closed");
}

test("failure formatting never includes a URL or raw exception text", async () => {
	const sentinel = "SENSITIVE_SENTINEL_URL_AND_EXCEPTION";
	const raw = new Error(`raw failure ${sentinel}`);
	const coded = await failure(() => preflight.responseBytes(`https://${sentinel}.invalid`, 16, "release", async () => { throw raw; }));
	for (const error of [coded, raw, new Error(`untrusted ${sentinel}`)]) {
		const message = preflight.formatPreflightFailure(error);
		assert.equal(message.includes(sentinel), false);
		assert.equal(message.includes("raw failure"), false);
	}
	assert.equal(preflight.formatPreflightFailure(coded), "Artifact preflight failed closed (release-metadata-fetch-transport); no package was installed and postinstall, setup, or launcher was run.");
	assert.equal(preflight.formatPreflightFailure(raw), "Artifact preflight failed closed (unknown); no package was installed and postinstall, setup, or launcher was run.");
});
