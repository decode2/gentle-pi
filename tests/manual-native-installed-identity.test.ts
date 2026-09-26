import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import { posix } from "node:path";
import { readFile } from "node:fs/promises";
import test from "node:test";

const moduleUrl = new URL("../scripts/manual-native-installed-identity.mjs", import.meta.url);
const api = () => import(moduleUrl.href);

function archive(entries) {
	const blocks = [];
	for (const { name, content = "", type = "0" } of entries) {
		const data = Buffer.from(content), header = Buffer.alloc(512);
		header.write(name, 0, 100, "utf8");
		for (const [offset, length, value] of [[100, 8, 0o644], [108, 8, 0], [116, 8, 0], [124, 12, data.length], [136, 12, 0]]) header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset, length, "ascii");
		header.fill(0x20, 148, 156);
		header[156] = type.charCodeAt(0);
		header.write("ustar\0", 257, 6, "ascii");
		header.write("00", 263, 2, "ascii");
		const checksum = header.reduce((sum, byte) => sum + byte, 0);
		header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "ascii");
		blocks.push(header, data, Buffer.alloc((512 - data.length % 512) % 512));
	}
	blocks.push(Buffer.alloc(1024));
	return gzipSync(Buffer.concat(blocks));
}

const sri = (bytes) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

function virtualIO(root, files = {}, extra = {}) {
	const directories = new Set(["/", "/scratch", "/scratch/prefix", posix.dirname(root), root, ...Object.keys(files).map((path) => posix.dirname(path))]);
	for (const original of [...directories]) {
		let path = original, parent = posix.dirname(path);
		while (parent !== path) { directories.add(parent); path = parent; parent = posix.dirname(path); }
	}
	const links = new Set(extra.links ?? []), contents = new Map(Object.entries(files).map(([path, bytes]) => [path, Buffer.from(bytes)]));
	return {
		assertDirectoryChain: async (path) => {
			let current = path;
			while (current !== "/") {
				if (links.has(current) || !directories.has(current)) throw new Error("unsafe installed directory");
				current = posix.dirname(current);
			}
		},
		readdir: async (directory) => {
			const names = new Set();
			for (const path of [...directories, ...contents.keys(), ...links]) if (posix.dirname(path) === directory) names.add(posix.basename(path));
			return [...names];
		},
		lstat: async (path) => ({
			isSymbolicLink: () => links.has(path),
			isDirectory: () => directories.has(path) && !links.has(path),
			isFile: () => contents.has(path) && !links.has(path),
		}),
		readFile: async (_layout, path) => contents.get(path),
	};
}

test("workflow runs installed-byte identity verification only after npm install smoke", async () => {
	const workflow = await readFile(new URL("../.github/workflows/manual-native-smoke.yml", import.meta.url), "utf8");
	const install = workflow.indexOf("node scripts/manual-native-staging.mjs install");
	const verify = workflow.indexOf("node scripts/manual-native-installed-identity.mjs verify");
	assert.ok(install >= 0 && verify > install, "the published package comparison must follow npm install");
	assert.match(workflow, /Compare published package files; nested Pi dependencies remain unverified; no postinstall\/Pi execution or Ready/);
	const script = await readFile(new URL("../scripts/manual-native-installed-identity.mjs", import.meta.url), "utf8");
	assert.match(script, /Published package files match; nested Pi dependencies unverified; no postinstall\/Pi execution or Ready/);
});

test("archive parser returns package files and rejects unsafe, duplicate, linked, and unexpected entries", async () => {
	const { parsePackageArchive } = await api();
	assert.equal(parsePackageArchive(archive([{ name: "package/index.js", content: "trusted" }])).get("index.js").toString(), "trusted");
	for (const entries of [
		[{ name: "package/../escape", content: "x" }],
		[{ name: "package\\..\\escape", content: "x" }],
		[{ name: "/package/escape", content: "x" }],
		[{ name: "package/a", content: "x" }, { name: "package/a", content: "y" }],
		[{ name: "package/a", content: "x" }, { name: "package/a/b", content: "y" }],
		[{ name: "package/double//slash", content: "x" }],
		[{ name: "package/link", type: "2" }],
		[{ name: "package/hardlink", type: "1" }],
		[{ name: "package/device", type: "3" }],
	]) assert.throws(() => parsePackageArchive(archive(entries)));
});

test("archive limits bound decompression, entry count, entry length, and aggregate bytes", async () => {
	const { parsePackageArchive } = await api();
	const bytes = archive([{ name: "package/a", content: "1234" }, { name: "package/b", content: "5678" }]);
	assert.throws(() => parsePackageArchive(bytes, { maxDecompressedBytes: 1024 }), /archive limits exceeded/);
	assert.throws(() => parsePackageArchive(bytes, { maxDecompressedBytes: 4096, maxEntries: 1 }), /archive limits exceeded/);
	assert.throws(() => parsePackageArchive(bytes, { maxDecompressedBytes: 4096, maxEntryBytes: 3 }), /archive limits exceeded/);
	assert.throws(() => parsePackageArchive(bytes, { maxDecompressedBytes: 4096, maxTotalBytes: 7 }), /archive limits exceeded/);
});

test("installed tree rejects symlinked ancestors, first-party files, and nested dependency directories", async () => {
	const { collectInstalledFiles } = await api(), root = "/scratch/prefix/node_modules/demo", file = `${root}/index.js`;
	await assert.rejects(collectInstalledFiles({}, root, virtualIO(root, { [file]: Buffer.from("x") }, { links: ["/scratch/prefix/node_modules"] })));
	await assert.rejects(collectInstalledFiles({}, root, virtualIO(root, {}, { links: [file] })));
	await assert.rejects(collectInstalledFiles({}, root, virtualIO(root, { [file]: Buffer.from("x") }, { links: [`${root}/node_modules`] }), { allowNestedDependencies: true }));
});

test("comparison permits only the Pi nested subtree as extra and rejects other files or directories", async () => {
	const { comparePackageFiles } = await api(), expected = new Map([["index.js", Buffer.from("same")]]);
	assert.equal(comparePackageFiles(expected, new Map([["index.js", Buffer.from("same")]])), true);
	const nested = new Map([["index.js", Buffer.from("same")], ["node_modules/dep/index.js", Buffer.from("unverified")]]);
	nested.directories = new Set(["node_modules", "node_modules/dep"]);
	assert.equal(comparePackageFiles(expected, nested, { allowNestedDependencies: true }), true);
	for (const actual of [new Map(), new Map([["index.js", Buffer.from("same")], ["extra", Buffer.from("x")]]), new Map([["index.js", Buffer.from("changed")]])]) assert.throws(() => comparePackageFiles(expected, actual));
	const unexpectedDirectory = new Map([["index.js", Buffer.from("same")]]);
	unexpectedDirectory.directories = new Set(["extra"]);
	assert.throws(() => comparePackageFiles(expected, unexpectedDirectory, { allowNestedDependencies: true }));
});

test("nested Pi dependency entry and byte caps are explicit", async () => {
	const { assertNestedDependencyLimits } = await api();
	assert.equal(assertNestedDependencyLimits(10000, 256 * 1024 * 1024), true);
	assert.throws(() => assertNestedDependencyLimits(10001, 0), /archive limits exceeded/);
	assert.throws(() => assertNestedDependencyLimits(1, 256 * 1024 * 1024 + 1), /archive limits exceeded/);
	assert.throws(() => assertNestedDependencyLimits(1, 0, 64 * 1024 * 1024 + 1), /archive limits exceeded/);
});

test("published Pi files match while nested dependencies remain explicitly unverified", async () => {
	const { verifyPublishedPackageFiles } = await api(), root = "/scratch/prefix/node_modules/@earendil-works/pi-coding-agent";
	const bytes = archive([{ name: "package/index.js", content: "published" }]), spec = { name: "@earendil-works/pi-coding-agent", version: "0.85.1", archiveName: "pi.tgz", integrity: sri(bytes) };
	const io = virtualIO(root, {
		[`${root}/index.js`]: Buffer.from("published"),
		[`${root}/node_modules/dependency/index.js`]: Buffer.from("unverified dependency"),
	});
	assert.equal(await verifyPublishedPackageFiles({ preflight: "/scratch/preflight", prefix: "/scratch/prefix" }, [spec], { io, readArchive: async () => bytes }), true);
});

test("both package identities require SRI and an unchanged staged archive", async () => {
	const { verifyPublishedPackageFiles } = await api(), root = "/scratch/prefix/node_modules/gentle-pi", scopedRoot = "/scratch/prefix/node_modules/@earendil-works/pi-coding-agent";
	const bytes = archive([{ name: "package/index.js", content: "shell" }]), scopedBytes = archive([{ name: "package/index.js", content: "pi" }]);
	const specs = [
		{ name: "gentle-pi", version: "1", archiveName: "gentle-pi.tgz", integrity: sri(bytes) },
		{ name: "@earendil-works/pi-coding-agent", version: "0.85.1", archiveName: "scope-pi.tgz", integrity: sri(scopedBytes) },
	];
	const layout = { preflight: "/scratch/preflight", prefix: "/scratch/prefix" };
	let reads = 0;
	const options = {
		io: virtualIO(root, { [`${root}/index.js`]: Buffer.from("shell"), [`${scopedRoot}/index.js`]: Buffer.from("pi") }),
		readArchive: async (_layout, spec) => { reads++; return spec === specs[0] ? bytes : scopedBytes; },
	};
	assert.equal(await verifyPublishedPackageFiles(layout, specs, options), true);
	assert.equal(reads, 4);
	reads = 0;
	await assert.rejects(verifyPublishedPackageFiles(layout, specs, { ...options, readArchive: async (_layout, spec) => {
		reads++;
		return spec === specs[1] && reads === 4 ? Buffer.from("changed") : spec === specs[0] ? bytes : scopedBytes;
	} }), /archive changed/);
	await assert.rejects(verifyPublishedPackageFiles(layout, specs, { ...options, readArchive: async () => Buffer.from("wrong") }));
	const noisyIO = { ...options.io, readdir: async () => { throw new Error("private path /must/not/escape"); } };
	await assert.rejects(verifyPublishedPackageFiles(layout, specs, { ...options, io: noisyIO }), { message: "unsafe installed package" });
});
