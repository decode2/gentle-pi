import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import * as staging from "../scripts/manual-native-staging.mjs";
import * as runtime from "../scripts/manual-native-runtime.mjs";

const node = "/hosted/node/24.0.0/arm64/bin/node";
const regular = async () => ({ isFile: () => true, isSymbolicLink: () => false });
const noDirectoryCheck = async () => {};
const lexicalPath = async (path) => path;

test("npm CLI paths derive from setup-node's Node distribution layout", () => {
	const mac = "/hosted/node/24.0.0/arm64", windows = "C:\\hostedtoolcache\\windows\\node\\24.0.0\\x64";
	assert.equal(staging.npmCliPathForNode(`${mac}/bin/node`, "darwin"), `${mac}/lib/node_modules/npm/bin/npm-cli.js`);
	assert.equal(staging.npmCliPathForNode(`${windows}\\node.exe`, "win32"), `${windows}\\node_modules\\npm\\bin\\npm-cli.js`);
});

test("npm CLI resolution fails closed and checks both ancestor chains and canonical binding", async () => {
	const cli = staging.npmCliPathForNode(node, "darwin"), checked = [];
	assert.equal(await staging.resolveNpmCli(node, "darwin", regular, async (path) => { checked.push(path); }, lexicalPath), cli);
	assert.deepEqual(checked, [dirname(node), dirname(cli)]);
	await assert.rejects(staging.resolveNpmCli(node, "darwin", async (path) => {
		if (path === node) return regular();
		throw new Error("missing");
	}, noDirectoryCheck, lexicalPath), /bundled Node or npm CLI unavailable/);
	await assert.rejects(staging.resolveNpmCli(node, "darwin", async (path) => ({ isFile: () => true, isSymbolicLink: () => path === cli }), noDirectoryCheck, lexicalPath), /bundled Node or npm CLI unavailable/);
	await assert.rejects(staging.resolveNpmCli(node, "darwin", regular, noDirectoryCheck, async (path) => path === cli ? "/outside/npm-cli.js" : path), /outside selected Node distribution/);
});

test("npm resolution refuses a symlinked npm CLI ancestor", async () => {
	const platform = process.platform === "win32" ? "win32" : "darwin";
	const base = await mkdtemp(join(tmpdir(), "manual-native-node-layout-")), root = join(base, "tool");
	const nodePath = platform === "win32" ? join(root, "node.exe") : join(root, "bin", "node");
	await mkdir(dirname(nodePath), { recursive: true });
	await writeFile(nodePath, "node");
	const external = join(base, "external"), ancestor = join(root, platform === "win32" ? "node_modules" : "lib");
	const cli = platform === "win32" ? join(external, "npm", "bin", "npm-cli.js") : join(external, "node_modules", "npm", "bin", "npm-cli.js");
	await mkdir(dirname(cli), { recursive: true });
	await writeFile(cli, "npm-cli");
	await symlink(external, ancestor, platform === "win32" ? "junction" : "dir");
	await assert.rejects(staging.resolveNpmCli(nodePath, platform), /unsafe scratch directory or symlink ancestor/);
});

test("install uses exact staged archives, disables scripts, and passes only the allowlist", async () => {
	const layout = runtime.resolveRuntimeLayout("/runner/_temp");
	const args = [
		"install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-package-lock",
		"--prefix", layout.prefix, "--userconfig", layout.npmUserConfig, "--globalconfig", layout.npmGlobalConfig,
		"--cache", layout.npmCache, "--registry", "https://registry.npmjs.org/",
		join(layout.preflight, "gentle-pi-3.7.0.tgz"), join(layout.preflight, "earendil-works-pi-coding-agent-0.85.1.tgz"),
	];
	assert.deepEqual(staging.buildNpmInstallArgs(layout), args);
	const source = { PATH: "/host/secret/bin", HOME: "/real/home", GH_TOKEN: "secret", NODE_OPTIONS: "--require=evil" };
	const invocation = await staging.resolveNpmInvocation(layout, source, node, "darwin", regular, noDirectoryCheck, lexicalPath);
	assert.equal(invocation.file, node);
	assert.deepEqual(invocation.args, [staging.npmCliPathForNode(node, "darwin"), ...args]);
	assert.equal(invocation.options.env.PATH.includes("/host/secret"), false);
	for (const key of ["GH_TOKEN", "NODE_OPTIONS"]) assert.equal(key in invocation.options.env, false);
	assert.equal(invocation.options.stdio, "ignore");
	assert.equal(invocation.options.shell, false);
});
