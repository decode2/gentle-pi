import assert from "node:assert/strict";
import test from "node:test";
import * as readerProbe from "../scripts/manual-native-darwin-reader-probe.mjs";

const { inspectDarwinReader } = readerProbe;
const THROW = Symbol("throw injected lstat value");
const thrown = (value) => ({ [THROW]: value });
const PATHS = ["/", "/usr", "/usr/bin", "/usr/bin/tar"];
const CATEGORIES = new Set([
	"darwin-reader-regular",
	"darwin-reader-missing-leaf",
	"darwin-reader-missing-ancestor",
	"darwin-reader-symlink-ancestor",
	"darwin-reader-symlink-leaf",
	"darwin-reader-nonregular-leaf",
	"darwin-reader-other-lstat-error",
]);
const stat = (kind) => ({
	isDirectory: () => kind === "directory",
	isSymbolicLink: () => kind === "symlink",
	isFile: () => kind === "file",
});
const directories = () => new Map([
	["/", stat("directory")],
	["/usr", stat("directory")],
	["/usr/bin", stat("directory")],
	["/usr/bin/tar", stat("file")],
]);

async function probe(entries) {
	const seen = [];
	const category = await inspectDarwinReader(async (path) => {
		seen.push(path);
		const entry = entries.get(path);
		if (entry && Object.hasOwn(entry, THROW)) throw entry[THROW];
		return entry;
	});
	return { category, seen };
}

test("lstats only the fixed Darwin reader chain and identifies a regular leaf", async () => {
	assert.deepEqual(await probe(directories()), {
		category: "darwin-reader-regular",
		seen: PATHS,
	});
});

test("returns fixed categories for missing and symlinked paths and a nonregular leaf", async () => {
	const cases = [
		["darwin-reader-missing-leaf", "/usr/bin/tar", thrown(Object.assign(new Error("HOSTILE_SENTINEL /private/path"), { code: "ENOENT" }))],
		["darwin-reader-missing-ancestor", "/usr/bin", thrown(Object.assign(new Error("HOSTILE_SENTINEL /private/path"), { code: "ENOENT" }))],
		["darwin-reader-symlink-ancestor", "/usr/bin", stat("symlink")],
		["darwin-reader-symlink-leaf", "/usr/bin/tar", stat("symlink")],
		["darwin-reader-nonregular-leaf", "/usr/bin/tar", stat("directory")],
	];
	for (const [expected, path, entry] of cases) {
		const entries = directories();
		entries.set(path, entry);
		const result = await probe(entries);
		assert.equal(result.category, expected);
		assert.equal(CATEGORIES.has(result.category), true);
		assert.equal(result.category.includes("HOSTILE_SENTINEL"), false);
		assert.deepEqual(result.seen, PATHS.slice(0, PATHS.indexOf(path) + 1));
	}
});

test("collapses hostile and unexpected lstat failures to a fixed safe category", async () => {
	const failures = [
		Object.assign(new Error("HOSTILE_SENTINEL /private/path --raw-arg"), { code: "EACCES" }),
		Object.defineProperty(new Error("HOSTILE_SENTINEL"), "code", { get() { throw new Error("HOSTILE_SENTINEL getter"); } }),
	];
	for (const failure of failures) {
		const entries = directories();
		entries.set("/usr/bin/tar", thrown(failure));
		const result = await probe(entries);
		assert.equal(result.category, "darwin-reader-other-lstat-error");
		assert.equal(CATEGORIES.has(result.category), true);
		assert.equal(result.category.includes("HOSTILE_SENTINEL"), false);
		assert.deepEqual(result.seen, PATHS);
	}
});

test("classifies malformed injected lstat results without exposing their contents", async () => {
	const entries = directories();
	entries.set("/usr/bin/tar", { HOSTILE_SENTINEL: "/private/path" });
	const result = await probe(entries);
	assert.equal(result.category, "darwin-reader-other-lstat-error");
	assert.equal(CATEGORIES.has(result.category), true);
});

test("checks missing and symlinked root ancestors before the rest of the fixed chain", async () => {
	for (const [entry, expected] of [
		[thrown(Object.assign(new Error("HOSTILE_SENTINEL"), { code: "ENOENT" })), "darwin-reader-missing-ancestor"],
		[stat("symlink"), "darwin-reader-symlink-ancestor"],
	]) {
		const entries = directories();
		entries.set("/", entry);
		const result = await probe(entries);
		assert.equal(result.category, expected);
		assert.equal(CATEGORIES.has(result.category), true);
		assert.deepEqual(result.seen, ["/"]);
	}
});

test("contains hostile proxies, invalid lstat results, and non-Error throws", async () => {
	const hostileError = new Proxy({}, { get() { throw new Error("HOSTILE_SENTINEL getter"); } });
	const hostileDetails = new Proxy({}, { get() { throw new Error("HOSTILE_SENTINEL stat"); } });
	const hostileResult = new Proxy({}, { get() { throw new Error("HOSTILE_SENTINEL result"); } });
	const cases = [
		[thrown(hostileError), "darwin-reader-other-lstat-error"],
		[thrown("HOSTILE_SENTINEL /private/path --raw-arg"), "darwin-reader-other-lstat-error"],
		[hostileDetails, "darwin-reader-other-lstat-error"],
		[{ isSymbolicLink: () => hostileResult, isDirectory: () => true }, "darwin-reader-other-lstat-error"],
	];
	for (const [entry, expected] of cases) {
		const entries = directories();
		entries.set("/", entry);
		const result = await probe(entries);
		assert.equal(result.category, expected);
		assert.equal(CATEGORIES.has(result.category), true);
		assert.equal(result.category.includes("HOSTILE_SENTINEL"), false);
		assert.deepEqual(result.seen, ["/"]);
	}
});

test("keeps CLI output fixed and returns zero for Darwin success and failure", async () => {
	assert.equal(typeof readerProbe.runProbeCli, "function");
	if (typeof readerProbe.runProbeCli !== "function") return;
	const emitted = { stdout: [], stderr: [] };
	const emit = {
		stdout: (text) => emitted.stdout.push(text),
		stderr: (text) => emitted.stderr.push(text),
	};
	const seen = [];
	const success = await readerProbe.runProbeCli({
		platform: "darwin",
		inspect: async (path) => { seen.push(path); return directories().get(path); },
		emit,
	});
	assert.equal(success, 0);
	assert.deepEqual(seen, PATHS);
	assert.deepEqual(emitted, { stdout: ["darwin-reader-regular\n"], stderr: [] });

	emitted.stdout.length = 0;
	const failure = await readerProbe.runProbeCli({
		platform: "darwin",
		inspect: async () => { throw new Error("HOSTILE_SENTINEL /private/path --raw-arg"); },
		emit,
	});
	assert.equal(failure, 0);
	assert.deepEqual(emitted, { stdout: ["darwin-reader-other-lstat-error\n"], stderr: [] });
});

test("contains a hostile CLI reporter and skips Windows with no output or lstat", async () => {
	assert.equal(typeof readerProbe.runProbeCli, "function");
	if (typeof readerProbe.runProbeCli !== "function") return;
	let reporterInput;
	const hostileEmit = new Proxy({}, {
		get(_target, key) {
			if (key === "stdout") return (text) => { reporterInput = text; throw new Error("HOSTILE_SENTINEL /private/path"); };
			throw new Error("HOSTILE_SENTINEL stderr");
		},
	});
	assert.equal(await readerProbe.runProbeCli({ platform: "darwin", inspect: async (path) => directories().get(path), emit: hostileEmit }), 0);
	assert.equal(reporterInput, "darwin-reader-regular\n");

	const emitted = { stdout: [], stderr: [] };
	let inspected = false;
	const result = await readerProbe.runProbeCli({
		platform: "win32",
		inspect: async () => { inspected = true; throw new Error("HOSTILE_SENTINEL"); },
		emit: { stdout: (text) => emitted.stdout.push(text), stderr: (text) => emitted.stderr.push(text) },
	});
	assert.equal(result, 0);
	assert.equal(inspected, false);
	assert.deepEqual(emitted, { stdout: [], stderr: [] });
});
