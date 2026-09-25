import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { GENTLE_PI_NPM_SRI, PI_NPM_ARCHIVE_NAME, PI_NPM_SRI, resolveScratchDirectory } from "./manual-native-preflight.mjs";

const fail = (message) => { throw new Error(message); };
const RUNTIME_NAME = "gentle-shell-manual-native-runtime";

export const STAGED_PACKAGES = Object.freeze([
	Object.freeze({ name: "gentle-pi", version: "3.7.0", integrity: GENTLE_PI_NPM_SRI, archiveName: "gentle-pi-3.7.0.tgz" }),
	Object.freeze({ name: "@earendil-works/pi-coding-agent", version: "0.85.1", integrity: PI_NPM_SRI, archiveName: PI_NPM_ARCHIVE_NAME }),
]);

export function resolveRuntimeLayout(runnerTemp) {
	const preflight = resolveScratchDirectory(runnerTemp), root = join(dirname(preflight), RUNTIME_NAME);
	return Object.freeze({
		runnerTemp: resolve(runnerTemp), root, preflight, prefix: join(root, "prefix"), home: join(root, "home"),
		xdgConfig: join(root, "xdg-config"), piAgent: join(root, "pi-agent"), gentlePiConfig: join(root, "gentle-pi-config"),
		npmUserConfig: join(root, "npmrc"), npmGlobalConfig: join(root, "global-npmrc"), npmCache: join(root, "npm-cache"), tmp: join(root, "tmp"),
	});
}

export function createStagingEnvironment(layout, source = process.env, platform = process.platform) {
	const value = (key) => source[key] ?? Object.entries(source).find(([name]) => name.toLowerCase() === key.toLowerCase())?.[1];
	const env = {
		HOME: layout.home, USERPROFILE: layout.home, XDG_CONFIG_HOME: layout.xdgConfig,
		PI_CODING_AGENT_DIR: layout.piAgent, GENTLE_PI_AGENT_HOME: layout.piAgent, GENTLE_PI_CONFIG_HOME: layout.gentlePiConfig,
		NPM_CONFIG_USERCONFIG: layout.npmUserConfig, NPM_CONFIG_GLOBALCONFIG: layout.npmGlobalConfig,
		NPM_CONFIG_CACHE: layout.npmCache, NPM_CONFIG_TMP: layout.tmp, NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
		NPM_CONFIG_IGNORE_SCRIPTS: "true", NPM_CONFIG_AUDIT: "false", NPM_CONFIG_FUND: "false",
		TMPDIR: layout.tmp, TMP: layout.tmp, TEMP: layout.tmp,
	};
	let paths;
	if (platform === "win32") {
		const root = value("SystemRoot");
		if (!root || !win32.isAbsolute(root)) fail("Windows system root unavailable");
		for (const key of ["SystemRoot", "WINDIR", "ComSpec", "PATHEXT"]) if (value(key)) env[key] = value(key);
		paths = [win32.dirname(process.execPath), win32.join(root, "System32"), root];
	} else paths = [dirname(process.execPath), "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
	return { ...env, PATH: [...new Set(paths)].join(platform === "win32" ? ";" : ":") };
}

export async function assertRealDirectoryChain(directory) {
	const absolute = resolve(directory), root = parse(absolute).root;
	let current = root;
	for (const part of ["", ...absolute.slice(root.length).split(sep).filter(Boolean)]) {
		if (part) current = join(current, part);
		const details = await lstat(current);
		if (!details.isDirectory() || details.isSymbolicLink()) fail("unsafe scratch directory or symlink ancestor");
	}
}

export async function assertScratchDirectories(layout) {
	for (const path of [layout.runnerTemp, layout.root, layout.preflight, layout.prefix, layout.home, layout.xdgConfig, layout.piAgent, layout.gentlePiConfig, layout.npmCache, layout.tmp]) await assertRealDirectoryChain(path);
	for (const path of [layout.npmUserConfig, layout.npmGlobalConfig]) {
		const details = await lstat(path);
		if (!details.isFile() || details.isSymbolicLink() || details.size !== 0) fail("unsafe npm config file");
	}
}

export async function assertSafeScratchPath(layout, path, allowedRoot) {
	const root = resolve(allowedRoot), target = resolve(path), fromRoot = relative(root, target);
	if (![resolve(layout.preflight), resolve(layout.prefix)].includes(root) || !fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) fail("unsafe scratch file path");
	await assertScratchDirectories(layout);
	await assertRealDirectoryChain(dirname(target));
}

export async function readBoundedRegularFile(layout, path, allowedRoot, maxBytes) {
	if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024) fail("invalid file size limit");
	await assertSafeScratchPath(layout, path, allowedRoot);
	const before = await lstat(path);
	if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) fail("unsafe or oversized regular file");
	const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) fail("file changed while opening");
		const chunks = [];
		let total = 0;
		while (total <= maxBytes) {
			const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
			if (!bytesRead) break;
			total += bytesRead;
			if (total > maxBytes) fail("oversized regular file");
			chunks.push(buffer.subarray(0, bytesRead));
		}
		const after = await handle.stat();
		if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs) fail("file changed while reading");
		await assertSafeScratchPath(layout, path, allowedRoot);
		return Buffer.concat(chunks, total);
	} finally { await handle.close(); }
}
