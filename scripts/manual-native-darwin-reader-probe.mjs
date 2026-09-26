import { lstat } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const READER_PATHS = Object.freeze(["/", "/usr", "/usr/bin", "/usr/bin/tar"]);
const OTHER_ERROR = "darwin-reader-other-lstat-error";

function isMissing(error) {
	try { return error?.code === "ENOENT"; } catch { return false; }
}

export async function inspectDarwinReader(inspect) {
	if (typeof inspect !== "function") return OTHER_ERROR;
	for (let index = 0; index < READER_PATHS.length; index += 1) {
		let details;
		try { details = await inspect(READER_PATHS[index]); } catch (error) {
			if (isMissing(error)) return index === READER_PATHS.length - 1 ? "darwin-reader-missing-leaf" : "darwin-reader-missing-ancestor";
			return OTHER_ERROR;
		}
		try {
			if (!details || typeof details.isSymbolicLink !== "function") return OTHER_ERROR;
			const symbolicLink = details.isSymbolicLink();
			if (typeof symbolicLink !== "boolean") return OTHER_ERROR;
			if (symbolicLink) return index === READER_PATHS.length - 1 ? "darwin-reader-symlink-leaf" : "darwin-reader-symlink-ancestor";
			if (index === READER_PATHS.length - 1) {
				if (typeof details.isFile !== "function") return OTHER_ERROR;
				const regularFile = details.isFile();
				if (typeof regularFile !== "boolean") return OTHER_ERROR;
				return regularFile ? "darwin-reader-regular" : "darwin-reader-nonregular-leaf";
			}
			if (typeof details.isDirectory !== "function") return OTHER_ERROR;
			const directory = details.isDirectory();
			if (typeof directory !== "boolean" || !directory) return OTHER_ERROR;
		} catch { return OTHER_ERROR; }
	}
	return OTHER_ERROR;
}

const DEFAULT_EMITTER = Object.freeze({
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
});

export async function runProbeCli({ platform = process.platform, inspect = lstat, emit = DEFAULT_EMITTER } = {}) {
	if (platform !== "darwin") return 0;
	let category;
	try { category = await inspectDarwinReader(inspect); } catch { category = OTHER_ERROR; }
	try { emit.stdout(`${category}\n`); } catch { /* diagnostics must not fail the smoke step */ }
	return 0;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
	runProbeCli().then((status) => { process.exitCode = status; }, () => { process.exitCode = 0; });
}
