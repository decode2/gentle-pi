import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type QuestionnaireGuidance = {
	description?: string;
	promptSnippet?: string;
	promptGuidelines?: string[];
	collapseKey?: string;
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
	if (!record(parsed) || !keysAreKnown(parsed, ["schema", "guidance", "collapseKey"]) || parsed.schema !== SCHEMA) return {};

	const guidance: QuestionnaireGuidance = {};
	if (Object.hasOwn(parsed, "guidance")) {
		if (!record(parsed.guidance) || !keysAreKnown(parsed.guidance, ["description", "promptSnippet", "promptGuidelines"])) return {};
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
	}
	if (Object.hasOwn(parsed, "collapseKey")) {
		const collapseKey = normalizeCollapseKey(parsed.collapseKey);
		if (collapseKey === undefined) return {};
		guidance.collapseKey = collapseKey;
	}
	return guidance;
}

function record(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function keysAreKnown(value: Record<string, unknown>, known: string[]): boolean {
	return Object.keys(value).every((key) => known.includes(key));
}

const COLLAPSE_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const COLLAPSE_NAMED_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end",
	"pageup", "pagedown", "up", "down", "left", "right", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);
const COLLAPSE_PRINTABLE_KEY = /^[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]$/;

function normalizeCollapseKey(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const key = value.trim().toLowerCase();
	if (key === "off") return key;
	if (key.length === 0 || key.startsWith("+") || key.endsWith("+") || key.includes("++")) return undefined;
	const parts = key.split("+");
	const base = parts.at(-1)!;
	const modifiers = parts.slice(0, -1);
	if (modifiers.length !== new Set(modifiers).size || !modifiers.every((modifier) => COLLAPSE_MODIFIERS.has(modifier))) return undefined;
	if (COLLAPSE_NAMED_KEYS.has(base)) return base.startsWith("f") && modifiers.length > 0 ? undefined : key;
	return COLLAPSE_PRINTABLE_KEY.test(base) ? key : undefined;
}

function nonemptyString(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0;
}
