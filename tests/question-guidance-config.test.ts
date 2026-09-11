import assert from "node:assert/strict";
import test from "node:test";
import {
	readQuestionnaireGuidanceConfig,
	type QuestionnaireGuidanceReadFile,
} from "../lib/questions/guidance-config.ts";

const agentHome = "/synthetic/agent-home";
const configPath = "/synthetic/agent-home/gentle-ai/ask-user-question.json";

type SyntheticRead = string | Error;

async function readSynthetic(source: SyntheticRead): Promise<{ result: Awaited<ReturnType<typeof readQuestionnaireGuidanceConfig>>; paths: string[] }> {
	const paths: string[] = [];
	const reader: QuestionnaireGuidanceReadFile = async (path) => {
		paths.push(path);
		if (source instanceof Error) throw source;
		return source;
	};
	return { result: await readQuestionnaireGuidanceConfig(agentHome, reader), paths };
}

function readError(code: string): Error {
	return Object.assign(new Error(code), { code });
}

test("reads only the first-party guidance path and preserves all configured nonempty bytes", async () => {
	const raw = JSON.stringify({
		schema: "gentle-pi.ask-user-question/v1",
		guidance: {
			description: "  configured description\t",
			promptSnippet: "\nconfigured snippet  ",
			promptGuidelines: ["  first guideline  ", "\tsecond guideline\t"],
		},
	});
	const { result, paths } = await readSynthetic(raw);
	assert.deepEqual(result, {
		description: "  configured description\t",
		promptSnippet: "\nconfigured snippet  ",
		promptGuidelines: ["  first guideline  ", "\tsecond guideline\t"],
	});
	assert.deepEqual(paths, [configPath]);
});

test("accepts sparse or empty guidance without inventing optional metadata", async (t) => {
	for (const scenario of [
		{ name: "guidance omitted", raw: JSON.stringify({ schema: "gentle-pi.ask-user-question/v1" }), expected: {} },
		{ name: "empty guidance", raw: JSON.stringify({ schema: "gentle-pi.ask-user-question/v1", guidance: {} }), expected: {} },
		{ name: "sparse prompt snippet", raw: JSON.stringify({ schema: "gentle-pi.ask-user-question/v1", guidance: { promptSnippet: " configured " } }), expected: { promptSnippet: " configured " } },
	]) {
		await t.test(scenario.name, async () => {
			const { result, paths } = await readSynthetic(scenario.raw);
			assert.deepEqual(paths, [configPath]);
			assert.deepEqual(result, scenario.expected);
		});
	}
});

test("falls back for missing, unreadable, malformed, or non-object configuration", async (t) => {
	for (const scenario of [
		{ name: "missing", source: readError("ENOENT") },
		{ name: "unreadable", source: readError("EACCES") },
		{ name: "bad JSON", source: "{" },
		{ name: "null", source: "null" },
		{ name: "array", source: "[]" },
	]) {
		await t.test(scenario.name, async () => {
			const { result, paths } = await readSynthetic(scenario.source);
			assert.deepEqual(paths, [configPath]);
			assert.deepEqual(result, {});
		});
	}
});

test("falls back unless the root and guidance have only known keys and the exact schema", async (t) => {
	const schema = "gentle-pi.ask-user-question/v1";
	for (const scenario of [
		{ name: "wrong schema", raw: JSON.stringify({ schema: "gentle-pi.ask-user-question/v2" }) },
		{ name: "unknown root key", raw: JSON.stringify({ schema, extra: true }) },
		{ name: "unknown guidance key", raw: JSON.stringify({ schema, guidance: { extra: true } }) },
		{ name: "raw own root __proto__ key", raw: `{"schema":"${schema}","__proto__":"rejected"}` },
		{ name: "raw own guidance __proto__ key", raw: `{"schema":"${schema}","guidance":{"__proto__":"rejected"}}` },
		{ name: "guidance is a string", raw: JSON.stringify({ schema, guidance: "not an object" }) },
	]) {
		await t.test(scenario.name, async () => {
			const { result, paths } = await readSynthetic(scenario.raw);
			assert.deepEqual(paths, [configPath]);
			assert.deepEqual(result, {});
		});
	}
});

test("falls back when configured strings or guideline arrays are empty, whitespace-only, or typed incorrectly", async (t) => {
	const schema = "gentle-pi.ask-user-question/v1";
	for (const scenario of [
		{ name: "empty description", guidance: { description: "" } },
		{ name: "whitespace description", guidance: { description: " \t\n " } },
		{ name: "numeric prompt snippet", guidance: { promptSnippet: 1 } },
		{ name: "whitespace prompt snippet", guidance: { promptSnippet: "  " } },
		{ name: "guidelines is a string", guidance: { promptGuidelines: "not an array" } },
		{ name: "empty guidelines", guidance: { promptGuidelines: [] } },
		{ name: "empty guideline item", guidance: { promptGuidelines: [""] } },
		{ name: "whitespace guideline item", guidance: { promptGuidelines: ["\t"] } },
		{ name: "non-string guideline item", guidance: { promptGuidelines: ["valid", 1] } },
	]) {
		await t.test(scenario.name, async () => {
			const { result, paths } = await readSynthetic(JSON.stringify({ schema, guidance: scenario.guidance }));
			assert.deepEqual(paths, [configPath]);
			assert.deepEqual(result, {});
		});
	}
});
