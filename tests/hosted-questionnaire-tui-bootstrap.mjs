import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const fixture = join(root, "tests/fixtures/questionnaire-tui-bootstrap");
const sdkRoot = realpathSync(join(root, "node_modules/@earendil-works/pi-coding-agent"));
const sdk = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
assert.equal(sdk.version, "0.85.1", "never substitute ambient Pi");
const cli = resolve(sdkRoot, typeof sdk.bin === "string" ? sdk.bin : sdk.bin.pi);

// Only the acquired frozen-lockfile checkout may run this hosted test.
test("UM-06a: explicit-path real Pi CLI TUI session_start sees exactly owned questionnaire", () => {
	assert.equal(process.env.CI, "true");
	const temporary = mkdtempSync(join(tmpdir(), "um06a-host-"));
	try {
		for (const owned of [false, true]) {
			const sandbox = join(temporary, owned ? "owned" : "absent");
			const agent = join(sandbox, "agent");
			const piAgent = join(sandbox, "pi-agent");
			const config = join(sandbox, "config");
			const home = join(sandbox, "home");
			const sessions = join(sandbox, "sessions");
			const cache = join(sandbox, "npm-cache");
			const trace = join(sandbox, "trace.jsonl");
			for (const path of [agent, piAgent, config, home, sessions, cache, join(sandbox, "xdg")]) mkdirSync(path, { recursive: true });
			if (owned) {
				mkdirSync(join(agent, "gentle-ai"));
				writeFileSync(join(agent, "gentle-ai/question-owner.json"),
					'{"version":1,"owner":"gentle-pi","enabled":true}\n');
			}
			const env = {
				PATH: process.env.PATH, TERM: "xterm-256color", CI: "true", PI_OFFLINE: "1",
				HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(sandbox, "xdg"),
				XDG_CACHE_HOME: join(sandbox, "xdg"), XDG_DATA_HOME: join(sandbox, "xdg"),
				PI_CODING_AGENT_DIR: piAgent, PI_CODING_AGENT_SESSION_DIR: sessions,
				GENTLE_PI_AGENT_HOME: agent, GENTLE_PI_CONFIG_HOME: config,
				NPM_CONFIG_CACHE: cache, NPM_CONFIG_USERCONFIG: join(sandbox, "npmrc"),
				NPM_CONFIG_GLOBALCONFIG: join(sandbox, "global-npmrc"),
				TMPDIR: sandbox, TMP: sandbox, TEMP: sandbox, UM06A_TRACE: trace,
			};
			const child = spawnSync("python3", [join(fixture, "pty.py"), process.execPath, cli,
				join(root, "extensions/ask-user-question.ts"), join(fixture, "trace.ts"), trace],
				{ env, cwd: root, encoding: "utf8", timeout: 55_000, maxBuffer: 256 * 1024 });
			assert.ifError(child.error);
			assert.equal(child.status, 0, child.stderr);
			const report = JSON.parse(child.stdout);
			assert.equal(report.started, true, JSON.stringify(report));
			const records = report.trace.trim().split("\n").map(JSON.parse);
			assert.deepEqual(records.map((item) => item.phase), ["factory", "session_start"]);
			assert.equal(records[1].mode, "tui", JSON.stringify(report));
			assert.deepEqual(records[1].tools, owned ? ["ask_user_question"] : [], JSON.stringify(report));
			console.log(`UM-06a explicit-path owned=${owned} sdk=${sdk.version} mode=tui tools=${JSON.stringify(records[1].tools)} exit=${report.exit}`);
		}
	} finally {
		rmSync(temporary, { recursive: true, force: true });
	}
});
