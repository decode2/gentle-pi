import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
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
