import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const artifact = process.env.RUNNER_TEMP;
assert.equal(process.env.CI, "true");
assert.ok(artifact?.startsWith("/artifact"), "hosted disposable artifact required");
const consumer = join(artifact, "consumer");
const installed = join(consumer, "node_modules/gentle-pi");
const receiptPath = join(artifact, "packed-receipt.json");
const digest = (path) => createHash("sha512").update(readFileSync(path)).digest("base64");

if (process.argv[2] === "acquire") {
	mkdirSync(join(artifact, "packed"));
	mkdirSync(consumer);
	writeFileSync(join(consumer, "package.json"), '{"name":"um06b-consumer","private":true}\n');
	const npm = (args, cwd) => {
		const result = spawnSync("npm", args, { cwd, encoding: "utf8", timeout: 120_000, maxBuffer: 1024 * 1024 });
		assert.ifError(result.error);
		assert.equal(result.status, 0, result.stderr);
		return result.stdout;
	};
	const packed = JSON.parse(npm(["pack", "--ignore-scripts", "--json", "--pack-destination", join(artifact, "packed")], root));
	assert.equal(packed.length, 1);
	assert.equal(packed[0].name, "gentle-pi");
	assert.match(packed[0].filename, /^gentle-pi-[\w.-]+\.tgz$/);
	const tarball = join(artifact, "packed", packed[0].filename);
	assert.equal(packed[0].integrity, `sha512-${digest(tarball)}`);
	npm(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--no-save", "--package-lock=false", "--legacy-peer-deps", tarball], consumer);
	assert.equal(JSON.parse(readFileSync(join(installed, "package.json"))).version, JSON.parse(readFileSync(join(root, "package.json"))).version);
	writeFileSync(receiptPath, JSON.stringify({ filename: packed[0].filename, integrity: packed[0].integrity, sha: process.env.EXPECTED_SHA }) + "\n");
	console.log(`UM-06b acquired packed=${packed[0].filename} sha=${process.env.EXPECTED_SHA} scripts=false`);
} else if (process.argv[2] === "probe") {
	test("UM-06b: installed tarball default package discovery gates questionnaire by disposable owner", () => {
		const sdkRoot = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent"));
		const sdk = JSON.parse(readFileSync(join(sdkRoot, "package.json")));
		assert.equal(sdk.version, "0.85.1", "never substitute ambient Pi");
		const cli = resolve(sdkRoot, typeof sdk.bin === "string" ? sdk.bin : sdk.bin.pi);
		const receipt = JSON.parse(readFileSync(receiptPath));
		assert.equal(receipt.sha, process.env.EXPECTED_SHA);
		assert.equal(receipt.integrity, `sha512-${digest(join(artifact, "packed", receipt.filename))}`);
		assert.equal(readFileSync(join(installed, "extensions/ask-user-question.ts"), "utf8"),
			readFileSync(join(root, "extensions/ask-user-question.ts"), "utf8"));
		const temporary = mkdtempSync(join(artifact, "um06b-probe-"));
		try {
			for (const owned of [false, true]) {
				const sandbox = join(temporary, owned ? "owned" : "absent");
				const agent = join(sandbox, "agent");
				const piAgent = join(sandbox, "pi-agent");
				const home = join(sandbox, "home");
				const trace = join(sandbox, "trace.jsonl");
				for (const path of [agent, piAgent, home, join(sandbox, "config"), join(sandbox, "xdg"), join(sandbox, "sessions"), join(sandbox, "npm-cache")]) mkdirSync(path, { recursive: true });
				writeFileSync(join(piAgent, "settings.json"), JSON.stringify({ packages: [installed], defaultProjectTrust: "never" }) + "\n");
				if (owned) {
					mkdirSync(join(agent, "gentle-ai"));
					writeFileSync(join(agent, "gentle-ai/question-owner.json"), '{"version":1,"owner":"gentle-pi","enabled":true}\n');
				}
				const env = {
					PATH: process.env.PATH, TERM: "xterm-256color", CI: "true", PI_OFFLINE: "1",
					HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(sandbox, "xdg"),
					XDG_CACHE_HOME: join(sandbox, "xdg"), XDG_DATA_HOME: join(sandbox, "xdg"),
					PI_CODING_AGENT_DIR: piAgent, PI_CODING_AGENT_SESSION_DIR: join(sandbox, "sessions"),
					GENTLE_PI_AGENT_HOME: agent, GENTLE_PI_CONFIG_HOME: join(sandbox, "config"),
					NPM_CONFIG_CACHE: join(sandbox, "npm-cache"), NPM_CONFIG_USERCONFIG: join(sandbox, "npmrc"),
					NPM_CONFIG_GLOBALCONFIG: join(sandbox, "global-npmrc"),
					TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox, UM06A_TRACE: trace,
				};
				const child = spawnSync("python3", [join(root, "tests/fixtures/questionnaire-tui-bootstrap/driver.py"),
					process.execPath, cli, join(root, "tests/fixtures/questionnaire-tui-bootstrap/trace.ts"), trace],
					{ env, cwd: consumer, encoding: "utf8", timeout: 55_000, maxBuffer: 256 * 1024 });
				assert.ifError(child.error);
				assert.equal(child.status, 0, child.stderr);
				const report = JSON.parse(child.stdout);
				assert.equal(report.started, true, JSON.stringify(report));
				const records = report.trace.trim().split("\n").map(JSON.parse);
				assert.deepEqual(records.map((item) => item.phase), ["factory", "session_start"], JSON.stringify(report));
				assert.equal(records[1].mode, "tui", JSON.stringify(report));
				assert.deepEqual(records[1].tools, owned ? ["ask_user_question"] : [], JSON.stringify(report));
				console.log(`UM-06b packed-default owned=${owned} sdk=${sdk.version} mode=tui tools=${JSON.stringify(records[1].tools)} deadline=${report.deadline_reached} exit=${report.exit} modelStarts=0`);
			}
		} finally {
			rmSync(temporary, { recursive: true, force: true });
		}
	});
} else {
	throw new Error("expected acquire or probe phase");
}
