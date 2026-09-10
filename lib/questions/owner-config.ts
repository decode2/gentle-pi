import { readFile } from "node:fs/promises";
import {
	questionOwnerConfigPath,
	resolveQuestionOwner,
	type QuestionOwnerResolution,
} from "./owner-gate.ts";

export type QuestionOwnerConfigReadFile = (path: string) => string | Promise<string>;

export type QuestionOwnerConfigResolution =
	| (QuestionOwnerResolution & { path: string })
	| { allowRegistration: false; reason: "read_error"; path: string; errorCode?: "EACCES" | "EISDIR" };

const readQuestionOwnerConfigFile: QuestionOwnerConfigReadFile = (path) => readFile(path, "utf8");

export async function readQuestionOwnerConfig(
	agentHome: string,
	injectedReadFile: QuestionOwnerConfigReadFile = readQuestionOwnerConfigFile,
): Promise<QuestionOwnerConfigResolution> {
	const path = questionOwnerConfigPath(agentHome);
	try {
		return withPath(resolveQuestionOwner(await injectedReadFile(path)), path);
	} catch (error) {
		const diagnostic = errorCode(error);
		if (diagnostic === "ENOENT") return withPath(resolveQuestionOwner(undefined), path);
		return diagnostic === "EACCES" || diagnostic === "EISDIR"
			? { allowRegistration: false, reason: "read_error", path, errorCode: diagnostic }
			: { allowRegistration: false, reason: "read_error", path };
	}
}

function withPath(resolution: QuestionOwnerResolution, path: string): QuestionOwnerConfigResolution {
	return { ...resolution, path };
}

function errorCode(error: unknown): string | undefined {
	try {
		if (typeof error !== "object" || error === null) return undefined;
		const code = Reflect.get(error, "code");
		return typeof code === "string" ? code : undefined;
	} catch {
		return undefined;
	}
}
