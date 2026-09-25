import { mkdir, writeFile, lstat, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyNpmIntegrity } from "./manual-native-preflight.mjs";
import {
	STAGED_PACKAGES, assertRealDirectoryChain, assertScratchDirectories, createStagingEnvironment,
	readBoundedRegularFile, resolveRuntimeLayout,
} from "./manual-native-runtime.mjs";

const fail = (message) => { throw new Error(message); };
const MAX_ARCHIVE_BYTES = 32 * 1024 * 1024;
const INSTALL_TIMEOUT_MS = 15 * 60 * 1000;
const STAGED_NPM_PACKAGES = STAGED_PACKAGES;

export function npmCliPathForNode(nodeExecutable, platform) {
	const pathApi = platform === "win32" ? win32 : platform === "darwin" ? posix : null;
	if (!pathApi || !pathApi.isAbsolute(nodeExecutable)) fail("unsupported or invalid Node executable path");
	const expectedNode = platform === "win32" ? "node.exe" : "node";
	if (pathApi.basename(nodeExecutable).toLowerCase() !== expectedNode) fail("unexpected Node executable path");
	const nodeRoot = platform === "win32" ? pathApi.dirname(nodeExecutable) : pathApi.dirname(pathApi.dirname(nodeExecutable));
	const npmParts = platform === "win32" ? ["node_modules", "npm", "bin", "npm-cli.js"] : ["lib", "node_modules", "npm", "bin", "npm-cli.js"];
	return pathApi.join(nodeRoot, ...npmParts);
}

export async function resolveNpmCli(nodeExecutable = process.execPath, platform = process.platform, inspect = lstat, checkDirectoryChain = assertRealDirectoryChain, canonicalize = realpath) {
	const cli = npmCliPathForNode(nodeExecutable, platform);
	const pathApi = platform === "win32" ? win32 : posix;
	const nodeRoot = platform === "win32" ? pathApi.dirname(nodeExecutable) : pathApi.dirname(pathApi.dirname(nodeExecutable));
	await checkDirectoryChain(pathApi.dirname(nodeExecutable));
	await checkDirectoryChain(pathApi.dirname(cli));
	for (const path of [nodeExecutable, cli]) {
		let details;
		try { details = await inspect(path); } catch { fail("bundled Node or npm CLI unavailable"); }
		if (!details.isFile() || details.isSymbolicLink()) fail("bundled Node or npm CLI unavailable");
	}
	let canonicalRoot, canonicalNode, canonicalCli;
	try {
		[canonicalRoot, canonicalNode, canonicalCli] = await Promise.all([canonicalize(nodeRoot), canonicalize(nodeExecutable), canonicalize(cli)]);
	} catch { fail("bundled Node or npm CLI unavailable"); }
	const expectedNode = platform === "win32" ? pathApi.join(canonicalRoot, "node.exe") : pathApi.join(canonicalRoot, "bin", "node");
	const expectedCli = pathApi.join(canonicalRoot, ...(platform === "win32" ? ["node_modules", "npm", "bin", "npm-cli.js"] : ["lib", "node_modules", "npm", "bin", "npm-cli.js"]));
	const samePath = (left, right) => platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
	if (!pathApi.isAbsolute(canonicalRoot) || !samePath(canonicalNode, expectedNode) || !samePath(canonicalCli, expectedCli)) fail("npm CLI resolves outside selected Node distribution");
	return canonicalCli;
}

export function buildNpmInstallArgs(layout) {
	return [
		"install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
		"--prefix", layout.prefix, "--userconfig", layout.npmUserConfig, "--globalconfig", layout.npmGlobalConfig,
		"--cache", layout.npmCache, "--registry", "https://registry.npmjs.org/",
		...STAGED_NPM_PACKAGES.map((spec) => join(layout.preflight, spec.archiveName)),
	];
}

export async function resolveNpmInvocation(layout, source = process.env, nodeExecutable = process.execPath, platform = process.platform, inspect = lstat, checkDirectoryChain = assertRealDirectoryChain, canonicalize = realpath) {
	const env = createStagingEnvironment(layout, source, platform);
	const npmCli = await resolveNpmCli(nodeExecutable, platform, inspect, checkDirectoryChain, canonicalize);
	const pathApi = platform === "win32" ? win32 : posix;
	if (!pathApi.isAbsolute(nodeExecutable) || !pathApi.isAbsolute(npmCli)) fail("invalid bundled Node/npm CLI path");
	return {
		file: nodeExecutable, args: [npmCli, ...buildNpmInstallArgs(layout)],
		options: { cwd: layout.prefix, env, shell: false, stdio: "ignore", windowsHide: true },
	};
}

async function verifyStagedArchives(layout) {
	await assertScratchDirectories(layout);
	for (const spec of STAGED_NPM_PACKAGES) {
		const archive = join(layout.preflight, spec.archiveName);
		const bytes = await readBoundedRegularFile(layout, archive, layout.preflight, MAX_ARCHIVE_BYTES);
		verifyNpmIntegrity(bytes, spec.integrity);
	}
}

async function runNpm(invocation) {
	await new Promise((resolvePromise, rejectPromise) => {
		let child, finished = false;
		const finish = (error) => {
			if (finished) return;
			finished = true;
			clearTimeout(timer);
			if (error) rejectPromise(Object.assign(new Error("npm install failed"), { code: "NPM_INSTALL_FAILED" }));
			else resolvePromise();
		};
		const timer = setTimeout(() => { child?.kill(); finish(true); }, INSTALL_TIMEOUT_MS);
		try {
			child = spawn(invocation.file, invocation.args, invocation.options);
			child.once("error", () => finish(true));
			child.once("close", (code) => finish(code !== 0));
		} catch { finish(true); }
	});
}

async function installStagedPackages(layout) {
	await verifyStagedArchives(layout);
	const invocation = await resolveNpmInvocation(layout);
	await verifyStagedArchives(layout);
	await runNpm(invocation);
}

async function prepare(layout) {
	await assertRealDirectoryChain(layout.runnerTemp);
	await assertRealDirectoryChain(layout.preflight);
	await mkdir(layout.root, { mode: 0o700 });
	await assertRealDirectoryChain(layout.root);
	for (const path of [layout.prefix, layout.home, layout.xdgConfig, layout.piAgent, layout.gentlePiConfig, layout.npmCache, layout.tmp]) {
		await mkdir(path, { mode: 0o700 });
		await assertRealDirectoryChain(path);
	}
	for (const path of [layout.npmUserConfig, layout.npmGlobalConfig]) await writeFile(path, "", { mode: 0o600, flag: "wx" });
	await assertScratchDirectories(layout);
}

async function runCli(args) {
	if (args.length !== 1 || !["prepare", "install"].includes(args[0])) fail("invalid staging command");
	const layout = resolveRuntimeLayout(process.env.RUNNER_TEMP);
	if (args[0] === "prepare") {
		await prepare(layout);
		console.log("Disposable npm staging prepared.");
		return;
	}
	try {
		await installStagedPackages(layout);
		console.log("npm install returned success, installed bytes unverified");
	} catch (error) {
		if (error?.code !== "NPM_INSTALL_FAILED") throw error;
		console.error("npm install failed; installed bytes unverified.");
		process.exitCode = 1;
	}
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runCli(process.argv.slice(2)).catch(() => { console.error("Native npm staging failed closed."); process.exitCode = 1; });
}
