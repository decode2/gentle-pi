import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const defaultWarningListeners = process.listeners("warning");
process.removeAllListeners("warning");
process.on("warning", (warning) => {
	if (!warning.message.startsWith("stripTypeScriptTypes is an experimental feature")) {
		for (const listener of defaultWarningListeners) listener(warning);
	}
});

export function load(url, context, nextLoad) {
	if (!url.endsWith(".ts")) return nextLoad(url, context);
	return {
		format: "module",
		source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), { mode: "strip" }),
		shortCircuit: true,
	};
}
