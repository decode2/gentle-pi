#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const temporary = mkdtempSync(join(tmpdir(), "gentle-pi-packed-runner-"));
const packDirectory = join(temporary, "pack");
const installDirectory = join(temporary, "install");

function windowsNpmInvocation() {
	const candidates = [];
	if (process.env.npm_execpath !== undefined && /[\\/]npm[\\/]bin[\\/]npm-cli\.js$/i.test(process.env.npm_execpath)) candidates.push(process.env.npm_execpath);
	for (const executable of new Set([process.execPath, realpathSync(process.execPath)])) candidates.push(join(dirname(executable), "node_modules", "npm", "bin", "npm-cli.js"));
	const installedCli = candidates.find((path) => existsSync(path));
	if (installedCli !== undefined) return { file: process.execPath, prefix: [installedCli] };
	let commandPaths = [];
	try { commandPaths = execFileSync("where.exe", ["npm"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/).filter(Boolean); }
	catch { /* fall through to the explicit resolution error */ }
	for (const path of commandPaths) {
		if (basename(path).toLowerCase() === "npm.exe") return { file: path, prefix: [] };
		const cli = join(dirname(path), "node_modules", "npm", "bin", "npm-cli.js");
		if (existsSync(cli)) return { file: process.execPath, prefix: [cli] };
	}
	throw new Error("could not resolve npm-cli.js without a command shell");
}

function runNpm(arguments_, options) {
	const invocation = process.platform === "win32" ? windowsNpmInvocation() : { file: "npm", prefix: [] };
	return execFileSync(invocation.file, [...invocation.prefix, ...arguments_], options);
}

try {
	mkdirSync(packDirectory);
	mkdirSync(installDirectory);
	const packed = JSON.parse(runNpm(["pack", "--ignore-scripts", "--json", "--pack-destination", packDirectory], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
}));
	if (packed.length !== 1 || typeof packed[0]?.filename !== "string") throw new Error("npm pack did not return one tarball");
	const tarball = join(packDirectory, packed[0].filename);
	writeFileSync(join(installDirectory, "package.json"), JSON.stringify({ name: "gentle-pi-packed-runner-test", private: true }), "utf8");
	runNpm(["install", "--ignore-scripts=false", "--no-audit", "--no-fund", "--package-lock=false", "--omit=dev", "--legacy-peer-deps", tarball], {
		cwd: installDirectory,
		stdio: "inherit",
	});
	const packageRoot = join(installDirectory, "node_modules", "gentle-pi");
	const modelsBin = join(installDirectory, "node_modules", ".bin", process.platform === "win32" ? "gentle-pi-models.cmd" : "gentle-pi-models");
	const modelsInvocation = process.platform === "win32"
		? { file: process.execPath, args: [join(packageRoot, "bin", "gentle-pi-models.mjs")] }
		: { file: modelsBin, args: [] };
	const modelsProbe = spawnSync(modelsInvocation.file, modelsInvocation.args, {
		cwd: installDirectory,
		input: `${JSON.stringify({ version: 1, contract: "gentle-pi.model-routing/v1", operation: "capabilities" })}\n`,
		encoding: "utf8",
	});
	if (modelsProbe.error) throw new Error(`installed gentle-pi-models executable did not start: ${modelsProbe.error.message}`);
	if (modelsProbe.status !== 0) throw new Error(`installed gentle-pi-models executable exited with status ${modelsProbe.status}: ${modelsProbe.stderr}`);
	if (modelsProbe.stderr !== "") throw new Error(`installed gentle-pi-models executable wrote stderr: ${JSON.stringify(modelsProbe.stderr)}`);
	const modelsOutput = modelsProbe.stdout.split(/\r?\n/);
	if (modelsOutput.at(-1) === "") modelsOutput.pop();
	if (modelsOutput.length !== 1 || modelsOutput[0] === "") throw new Error("installed gentle-pi-models executable did not return exactly one JSON response");
	const modelsResponse = JSON.parse(modelsOutput[0]);
	if (
		modelsResponse.version !== 1 ||
		modelsResponse.contract !== "gentle-pi.model-routing/v1" ||
		modelsResponse.operation !== "capabilities" ||
		modelsResponse.exitClass !== "success" ||
		modelsResponse.ok !== true ||
		modelsResponse.result?.contract !== "gentle-pi.model-routing/v1" ||
		modelsResponse.result?.supported !== true ||
		JSON.stringify(modelsResponse.result?.operations) !== JSON.stringify(["capabilities", "inspect", "validate", "apply"])
	) throw new Error("installed gentle-pi-models executable returned incompatible capabilities");
	const runner = join(packageRoot, "scripts", "run-git-commit-transaction.mjs");
	const result = JSON.parse(execFileSync(process.execPath, [runner, "self-test"], { cwd: installDirectory, encoding: "utf8" }));
	if (result.schema !== "gentle-pi.git-commit-transaction-runner-self-test/v1" || !Array.isArray(result.states) || !result.states.includes("prepared") || !result.states.includes("committed")) {
		throw new Error("installed transaction runner self-test returned an incompatible result");
	}
	const versions = readdirSync(join(packageRoot, ".gentle-ai"), { withFileTypes: true }).filter((entry) => entry.isDirectory() && /^v\d+\.\d+\.\d+$/.test(entry.name));
	if (versions.length !== 1) throw new Error("packed install did not contain exactly one package-local Gentle AI version");
	const executable = join(packageRoot, ".gentle-ai", versions[0].name, process.platform === "win32" ? "gentle-ai.exe" : "gentle-ai");
	const capabilities = JSON.parse(execFileSync(executable, ["review", "capabilities", "--contract", "gentle-ai.review-integration/v2"], { cwd: installDirectory, encoding: "utf8" }));
	// Decode with the PACKED consumer's own decoder rather than comparing the
	// schema string against a list hand-copied into this script. The copy was a
	// second, silent pin: it accepted only `capabilities/v2`, so the moment the
	// pinned provider advertised an additive minor this E2E rejected a pairing
	// that gentle-pi reads correctly, and it would have done so again on the
	// next minor. Using the shipped decoder makes the assertion what it always
	// meant to be — the packed consumer can read the packed provider — and it
	// checks the whole envelope (protocol major/minor, required operations,
	// gates, projections, advertised schemas, mandatory features, and the
	// self-reported executable digest) instead of one string.
	const { decodeReviewCapabilitiesV2 } = await import(pathToFileURL(join(packageRoot, "runtime", "review-integration-v2.mjs")).href);
	const executableDigest = `sha256:${createHash("sha256").update(readFileSync(executable)).digest("hex")}`;
	const decoded = decodeReviewCapabilitiesV2(capabilities, executableDigest);
	if (decoded.contract !== "gentle-ai.review-integration/v2" || decoded.packageVersion !== versions[0].name.slice(1)) throw new Error("package-local Gentle AI returned incompatible capabilities");
	const packageManifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
	process.stdout.write(`packed runner E2E passed (gentle-pi ${packageManifest.version ?? "unknown"}; Gentle AI ${capabilities.package?.version ?? "unknown"}; ${result.states.length} states)\n`);
} finally {
	rmSync(temporary, { recursive: true, force: true });
}
