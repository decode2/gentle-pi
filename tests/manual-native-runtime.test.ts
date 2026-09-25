import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { tmpdir } from "node:os";
import * as runtime from "../scripts/manual-native-runtime.mjs";

async function scratch(withPrefix = true) {
	const base = await mkdtemp(join(tmpdir(), "manual-native-staging-"));
	const runnerTemp = join(base, "_temp");
	await mkdir(runnerTemp);
	const layout = runtime.resolveRuntimeLayout(runnerTemp);
	await mkdir(layout.root);
	await mkdir(layout.preflight);
	for (const path of [layout.prefix, layout.home, layout.xdgConfig, layout.piAgent, layout.gentlePiConfig, layout.npmCache, layout.tmp]) {
		if (path !== layout.prefix || withPrefix) await mkdir(path);
	}
	await writeFile(layout.npmUserConfig, "");
	await writeFile(layout.npmGlobalConfig, "");
	return { base, runnerTemp, layout };
}

test("scratch selectors remain beneath a disposable runner _temp", async () => {
	const { layout, runnerTemp } = await scratch();
	assert.equal(layout.prefix, join(layout.root, "prefix"));
	assert.throws(() => runtime.resolveRuntimeLayout("relative"), /unsafe scratch root/);
	assert.throws(() => runtime.resolveRuntimeLayout(`${runnerTemp}${sep}..${sep}outside`), /unsafe scratch root/);
});

test("staging environment isolates homes and excludes host PATH and credentials", async () => {
	const { layout } = await scratch();
	const env = runtime.createStagingEnvironment(layout, {
		PATH: "/host/secret/bin", HOME: "/real/home", NPM_CONFIG_USERCONFIG: "/real/.npmrc",
		SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe", PATHEXT: ".COM;.EXE",
		GH_TOKEN: "secret", GITHUB_TOKEN: "secret", NPM_TOKEN: "secret", NODE_OPTIONS: "--require=evil",
	});
	assert.equal(env.HOME, layout.home);
	assert.equal(env.USERPROFILE, layout.home);
	assert.equal(env.XDG_CONFIG_HOME, layout.xdgConfig);
	assert.equal(env.NPM_CONFIG_USERCONFIG, layout.npmUserConfig);
	assert.equal(env.NPM_CONFIG_GLOBALCONFIG, layout.npmGlobalConfig);
	assert.equal(env.NPM_CONFIG_CACHE, layout.npmCache);
	assert.equal(env.TMP, layout.tmp);
	assert.equal(env.PATH.includes("/host/secret"), false);
	for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "NODE_OPTIONS"]) assert.equal(key in env, false);
});

test("bounded reads accept regular files and reject oversized files", async () => {
	const { layout } = await scratch();
	const file = join(layout.prefix, "bounded-input.bin");
	await writeFile(file, "small");
	assert.equal((await runtime.readBoundedRegularFile(layout, file, layout.prefix, 8)).toString(), "small");
	await writeFile(file, "oversized");
	await assert.rejects(runtime.readBoundedRegularFile(layout, file, layout.prefix, 4), /unsafe|oversized/);
});

test("bounded reads reject a symlinked scratch ancestor", async () => {
	const { layout } = await scratch(false);
	const target = join(layout.root, "outside-prefix");
	await mkdir(target);
	await writeFile(join(target, "artifact.tgz"), "bytes");
	await symlink(target, layout.prefix, process.platform === "win32" ? "junction" : "dir");
	await assert.rejects(runtime.readBoundedRegularFile(layout, join(layout.prefix, "artifact.tgz"), layout.prefix, 32), /unsafe|symlink/);
});
