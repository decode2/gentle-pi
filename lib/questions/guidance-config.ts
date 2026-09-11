import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type QuestionnaireGuidance = {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
};

export type QuestionnaireGuidanceReadFile = (path: string) => string | Promise<string>;

const SCHEMA = "gentle-pi.ask-user-question/v1";
const readQuestionnaireGuidanceConfigFile: QuestionnaireGuidanceReadFile = (path) => readFile(path, "utf8");

export async function readQuestionnaireGuidanceConfig(
	agentHome: string,
	injectedReadFile: QuestionnaireGuidanceReadFile = readQuestionnaireGuidanceConfigFile,
): Promise<QuestionnaireGuidance> {
	try {
		return parseGuidance(await injectedReadFile(join(agentHome, "gentle-ai", "ask-user-question.json")));
	} catch {
		return {};
	}
}

function parseGuidance(raw: string): QuestionnaireGuidance {
	const parsed = JSON.parse(raw) as unknown;
	if (!record(parsed) || !keysAreKnown(parsed, ["schema", "guidance"]) || parsed.schema !== SCHEMA) return {};
	if (!Object.hasOwn(parsed, "guidance")) return {};
	if (!record(parsed.guidance) || !keysAreKnown(parsed.guidance, ["description", "promptSnippet", "promptGuidelines"])) return {};

	const guidance: QuestionnaireGuidance = {};
	if (Object.hasOwn(parsed.guidance, "description")) {
		if (!nonemptyString(parsed.guidance.description)) return {};
		guidance.description = parsed.guidance.description;
	}
	if (Object.hasOwn(parsed.guidance, "promptSnippet")) {
		if (!nonemptyString(parsed.guidance.promptSnippet)) return {};
		guidance.promptSnippet = parsed.guidance.promptSnippet;
	}
	if (Object.hasOwn(parsed.guidance, "promptGuidelines")) {
		const guidelines = parsed.guidance.promptGuidelines;
		if (!Array.isArray(guidelines) || guidelines.length === 0 || !guidelines.every(nonemptyString)) return {};
		guidance.promptGuidelines = [...guidelines];
	}
	return guidance;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysAreKnown(value: Record<string, unknown>, known: string[]): boolean {
	return Object.keys(value).every((key) => known.includes(key));
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
