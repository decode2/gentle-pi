import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	MAX_EXECUTABLE_MEMBER_BYTES,
	MAX_SCRIPT_MEMBER_BYTES,
	safeFailureCode,
	validateOfficialZipBuffer,
} from "../scripts/manual-native-zip-official-probe.mjs";

const names = ["tools/cloud-sync-projects.ps1", "tools/cloud-sync-projects.sh", "engram.exe"];
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function zip(entries: Array<{ name: string; data?: Buffer; method?: number; size?: number; mode?: number }>) {
	const locals: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const entry of entries) {
		const name = Buffer.from(entry.name, "ascii");
		const data = entry.data ?? Buffer.from("x");
		const method = entry.method ?? 0;
		const size = entry.size ?? data.length;
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(method, 8);
		local.writeUInt16LE(0, 14);
		local.writeUInt32LE(data.length, 18);
		local.writeUInt32LE(size, 22);
		local.writeUInt16LE(name.length, 26);
		locals.push(Buffer.concat([local, name, data]));

		const header = Buffer.alloc(46);
		header.writeUInt32LE(0x02014b50, 0);
		header.writeUInt16LE((3 << 8) | 20, 4);
		header.writeUInt16LE(method, 10);
		header.writeUInt32LE(0, 16);
		header.writeUInt32LE(data.length, 20);
		header.writeUInt32LE(size, 24);
		header.writeUInt16LE(name.length, 28);
		header.writeUInt32LE(((entry.mode ?? 0o100644) * 0x10000) >>> 0, 38);
		header.writeUInt32LE(offset, 42);
		central.push(Buffer.concat([header, name]));
		offset += locals.at(-1)!.length;
	}
	const localBytes = Buffer.concat(locals);
	const centralBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(entries.length, 8);
	end.writeUInt16LE(entries.length, 10);
	end.writeUInt32LE(centralBytes.length, 12);
	end.writeUInt32LE(localBytes.length, 16);
	return Buffer.concat([localBytes, centralBytes, end]);
}

function validate(bytes: Buffer, platform = "win32", architecture = "x64") {
	return validateOfficialZipBuffer(bytes, { name: "synthetic.zip", sha256: digest(bytes) }, platform, architecture);
}

function failure(bytes: Buffer, expectedCode: string) {
	let error: unknown;
	try { validate(bytes); } catch (caught) { error = caught; }
	assert.ok(error instanceof Error, "expected closed validation failure");
	assert.equal(safeFailureCode(error), expectedCode);
	return error;
}

test("accepts the exact three regular official Windows ZIP members for both architectures", () => {
	const bytes = zip(names.map((name) => ({ name })));
	for (const architecture of ["x64", "arm64"]) {
		assert.equal(validateOfficialZipBuffer(bytes, { name: "synthetic.zip", sha256: digest(bytes) }, "win32", architecture), "official-zip-inventory-valid");
	}
});

test("rejects a Buffer whose SHA-256 differs from the expected asset digest", () => {
	const bytes = zip(names.map((name) => ({ name })));
	assert.equal(validate(bytes), "official-zip-inventory-valid");
	let error: unknown;
	try { validateOfficialZipBuffer(bytes, { name: "synthetic.zip", sha256: "0".repeat(64) }, "win32", "x64"); } catch (caught) { error = caught; }
	assert.ok(error instanceof Error);
	assert.equal(safeFailureCode(error), "official-zip-digest-mismatch");
});

test("rejects missing, wrong, and extra members with a fixed manifest category", () => {
	failure(zip(names.slice(0, 2).map((name) => ({ name }))), "official-zip-manifest-rejected");
	failure(zip(["tools/cloud-sync-projects.ps1", "tools/cloud-sync-projects.sh", "wrong.exe"].map((name) => ({ name }))), "official-zip-manifest-rejected");
	failure(zip([...names, "extra.txt"].map((name) => ({ name }))), "official-zip-manifest-rejected");
});

test("rejects symlinks and members beyond fixed size bounds", () => {
	failure(zip(names.map((name) => ({ name, mode: name === "engram.exe" ? 0o120777 : 0o100644 }))), "official-zip-compatibility-unknown");
	failure(zip(names.map((name) => ({ name, ...(name.endsWith(".ps1") ? { method: 8, data: Buffer.alloc(0), size: MAX_SCRIPT_MEMBER_BYTES + 1 } : {}) }))), "official-zip-manifest-rejected");
	failure(zip(names.map((name) => ({ name, ...(name === "engram.exe" ? { method: 8, data: Buffer.alloc(0), size: MAX_EXECUTABLE_MEMBER_BYTES + 1 } : {}) }))), "official-zip-manifest-rejected");
});

test("public failures never expose hostile member names, argv, or raw errors", () => {
	const sentinel = "RAW_MEMBER_PATH_SENTINEL";
	const error = failure(zip(["../" + sentinel].map((name) => ({ name }))), "official-zip-compatibility-unknown");
	assert.equal(error.message.includes(sentinel), false);
	assert.equal(safeFailureCode(new Error(`/private/${sentinel} raw exception`)), "unknown");
	const script = fileURLToPath(new URL("../scripts/manual-native-zip-official-probe.mjs", import.meta.url));
	const result = spawnSync(process.execPath, [script, sentinel], { encoding: "utf8", env: { PATH: "", HOME: "" } });
	assert.equal(result.status, 1);
	assert.equal(result.stdout, "");
	assert.equal(result.stderr, "unknown\n");
	assert.equal(result.stderr.includes(sentinel), false);
});
