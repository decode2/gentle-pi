import { createHash } from "node:crypto";
import { mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const GENTLE_PI_NPM_SRI = "sha512-SXBp9jIRnVIcOsLCW/Zw4XDTXxhViXNxrCZS7LyioB6kdRl99Ohojeaj+yIH5+K/ucwLlTlHYBz8zwue9aspNQ==";
export const PI_NPM_SRI = "sha512-FGRN+OHbWaefBPGaTggAdLjrIHW+s2PzLyglz/5dfLzb9of7uuXMXYC0fJIeZTw+shS32o2cuQ9jF7YSDuL/oQ==";
export const PI_NPM_ARCHIVE_NAME = "earendil-works-pi-coding-agent-0.85.1.tgz";
export const ENGRAM_VERSION = "2.1.0";
export const ENGRAM_CHECKSUMS_SHA256 = "b08d2a0e214330bc1d5be7683ba242e4f5b4b1b7592c58b5baaecd5dfb9a8a42";
// Pins from the official v2.1.0 release assets; runtime also requires the API
// asset digest and official checksum row to match these immutable values.
const RELEASE_TAG = `v${ENGRAM_VERSION}`;
const RELEASE_API = `https://api.github.com/repos/Gentleman-Programming/engram/releases/tags/${RELEASE_TAG}`;
const RELEASE_DOWNLOAD = `https://github.com/Gentleman-Programming/engram/releases/download/${RELEASE_TAG}/`;
const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

export const ENGRAM_RELEASE_ASSETS = Object.freeze({
	"darwin/x64": Object.freeze({ name: "engram_2.1.0_darwin_amd64.tar.gz", sha256: "2c8f56f36c6779b1c0f5f56bf9339ed121192218272e4fc144a8ad7bed2da22c" }),
	"darwin/arm64": Object.freeze({ name: "engram_2.1.0_darwin_arm64.tar.gz", sha256: "b9167999ba6deca652e367bd7d44766afa33430ab93b01f7cc0be42e6364d806" }),
	"win32/x64": Object.freeze({ name: "engram_2.1.0_windows_amd64.zip", sha256: "342ace84c1a716c5e6cd969ed92fe63c8b00304cd8bd1bd6455247db4f9afc9c" }),
	"win32/arm64": Object.freeze({ name: "engram_2.1.0_windows_arm64.zip", sha256: "cdd2ec6e718140cb2d67e0170151baecba63fdcbaa09ef23107459aa2cce695e" }),
});

const fail = (message) => { throw new Error(message); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function verifyNpmIntegrity(bytes, expected) {
	if (!(bytes instanceof Uint8Array) || typeof expected !== "string" || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(expected)) fail("invalid integrity");
	const actual = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
	if (actual !== expected) fail("integrity mismatch");
	return true;
}

export function resolveEngramReleaseAsset(platform, architecture) {
	const asset = ENGRAM_RELEASE_ASSETS[`${platform}/${architecture}`];
	if (!asset) fail("unsupported platform/architecture");
	return asset;
}

export function resolveScratchDirectory(runnerTemp) {
	if (typeof runnerTemp !== "string" || !runnerTemp || !isAbsolute(runnerTemp) || runnerTemp.includes("\0") || runnerTemp.split(/[\\/]/).includes("..")) fail("unsafe scratch root");
	const root = resolve(runnerTemp);
	if (root === parse(root).root || parse(root).name !== "_temp") fail("unsafe scratch root");
	return join(root, "gentle-shell-manual-native-preflight");
}

function releaseAsset(release, name) {
	const matches = Array.isArray(release?.assets) ? release.assets.filter((asset) => asset?.name === name) : [];
	if (matches.length !== 1 || typeof matches[0].digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(matches[0].digest)) fail("missing official digest");
	return matches[0].digest.slice("sha256:".length);
}

function checksumFor(text, name) {
	if (typeof text !== "string") fail("missing or invalid checksum row");
	const rows = text.split(/\r?\n/).filter(Boolean).map((line) => /^([a-f0-9]{64}) {2}([^\s]+)$/.exec(line));
	if (rows.some((row) => row === null)) fail("missing or invalid checksum row");
	const matching = rows.filter((row) => row[2] === name);
	if (matching.length !== 1 || new Set(rows.map((row) => row[2])).size !== rows.length) fail("missing or invalid checksum row");
	return matching[0][1];
}

export function verifyEngramArtifacts({ release, checksumText, checksumSha256, archiveSha256, platform, architecture }) {
	if (release?.tag_name !== RELEASE_TAG || release.draft !== false || release.prerelease !== false) fail("release drift");
	const target = resolveEngramReleaseAsset(platform, architecture);
	const apiArchiveSha = releaseAsset(release, target.name);
	const apiChecksumsSha = releaseAsset(release, "checksums.txt");
	if (apiArchiveSha !== target.sha256 || apiChecksumsSha !== ENGRAM_CHECKSUMS_SHA256) fail("release drift");
	if (checksumSha256 !== ENGRAM_CHECKSUMS_SHA256) fail("checksum file digest mismatch");
	const listedSha = checksumFor(checksumText, target.name);
	if (listedSha !== target.sha256 || archiveSha256 !== target.sha256 || archiveSha256 !== apiArchiveSha || listedSha !== apiArchiveSha) fail("archive digest mismatch");
	return target.name;
}

async function responseBytes(url, maxBytes) {
	const response = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "gentle-pi-manual-native-preflight", "X-GitHub-Api-Version": "2022-11-28" } });
	if (!response.ok || !response.body) fail("artifact fetch failed");
	const chunks = [];
	let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > maxBytes) fail("artifact exceeds size limit");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks);
}

async function realDirectory(path) {
	const details = await lstat(path);
	if (!details.isDirectory() || details.isSymbolicLink()) fail("unsafe scratch directory");
}

async function prepare() {
	const root = resolveScratchDirectory(process.env.RUNNER_TEMP);
	await realDirectory(resolve(process.env.RUNNER_TEMP));
	await mkdir(root, { mode: 0o700 });
	await realDirectory(root);
}

async function scratchFile(root, name, maxBytes = MAX_ARTIFACT_BYTES) {
	const path = join(root, name);
	const details = await lstat(path);
	if (!details.isFile() || details.isSymbolicLink() || details.size > maxBytes) fail("unsafe or oversized staged artifact");
	return readFile(path);
}

async function verify() {
	const root = resolveScratchDirectory(process.env.RUNNER_TEMP);
	await realDirectory(root);
	const gentlePi = await scratchFile(root, "gentle-pi-3.7.0.tgz");
	const pi = await scratchFile(root, PI_NPM_ARCHIVE_NAME);
	verifyNpmIntegrity(gentlePi, GENTLE_PI_NPM_SRI);
	verifyNpmIntegrity(pi, PI_NPM_SRI);

	const target = resolveEngramReleaseAsset(process.platform, process.arch);
	const [releaseBytes, checksumBytes, archiveBytes] = await Promise.all([
		responseBytes(RELEASE_API, 2 * 1024 * 1024),
		responseBytes(`${RELEASE_DOWNLOAD}checksums.txt`, 64 * 1024),
		responseBytes(`${RELEASE_DOWNLOAD}${target.name}`, MAX_ARTIFACT_BYTES),
	]);
	let release;
	try { release = JSON.parse(releaseBytes.toString("utf8")); } catch { fail("invalid release metadata"); }
	const checksumText = checksumBytes.toString("utf8");
	verifyEngramArtifacts({ release, checksumText, checksumSha256: sha256(checksumBytes), archiveSha256: sha256(archiveBytes), platform: process.platform, architecture: process.arch });
	await writeFile(join(root, "checksums.txt"), checksumBytes, { flag: "wx", mode: 0o600 });
	await writeFile(join(root, target.name), archiveBytes, { flag: "wx", mode: 0o600 });
}

async function runCli(args) {
	if (args.length !== 1) fail("invalid command");
	if (args[0] === "prepare") {
		await prepare();
		console.log("Disposable artifact scratch prepared.");
		return;
	}
	if (args[0] === "verify") {
		await verify();
		console.log("Artifact preflight passed; packages were not installed and postinstall, setup, or launcher was not run.");
		return;
	}
	fail("invalid command");
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runCli(process.argv.slice(2)).catch(() => {
		console.error("Artifact preflight failed closed; no package was installed and postinstall, setup, or launcher was run.");
		process.exitCode = 1;
	});
}
