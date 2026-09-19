import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { access, constants, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { networkInterfaces, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import test from "node:test";

const CHECKOUT_ROOT = "/workspace";
const REFERENCE_ROOT = "/reference";
const TOOL_NAME = "ask_user_question";
const PROVIDER_ID = "hosted-questionnaire-synthetic";
const MODEL_ID = "hosted-questionnaire-model";
const QUESTION = "Which layout should we inspect?";
const SECOND_QUESTION = "Which spacing should we inspect?";
const THIRD_QUESTION = "Which options should we compare?";
const CUSTOM_ANSWER = "  leading  internal\ntrailing  ";
const DECLINE_MESSAGE = "User declined to answer questions";
const FINAL_TEXT = {
	cancel: "Synthetic provider completed after questionnaire cancellation.",
	single: "Synthetic provider completed after questionnaire single selection.",
	custom: "Synthetic provider completed after questionnaire custom response.",
	multi: "Synthetic provider completed after questionnaire multi selection.",
	"empty-multi": "Synthetic provider completed after questionnaire empty multi selection.",
	"partial-cancel": "Synthetic provider completed after questionnaire partial cancellation.",
	"schema-positive": "Synthetic provider completed after questionnaire schema-positive cancellation.",
	"invalid-missing-questions": "Synthetic provider completed after missing-questions schema rejection.",
	"invalid-empty-questions": "Synthetic provider completed after empty-questions schema rejection.",
	"invalid-one-option": "Synthetic provider completed after one-option schema rejection.",
} as const;
const CANCELLED_MARKER = "hosted:ask_user_question:cancelled";
const COMPLETED_MARKER = "hosted:ask_user_question:completed";
const ISOLATION_MARKER = "docker-network-none-readonly-v1";
const OWNED_EXTENSION_PATH = `${CHECKOUT_ROOT}/extensions/ask-user-question.ts`;
const REFERENCE_EXTENSION_PATH = `${REFERENCE_ROOT}/node_modules/@juicesharp/rpiv-ask-user-question/index.ts`;
const REFERENCE_PACKAGE_ROOT = `${REFERENCE_ROOT}/node_modules/@juicesharp/rpiv-ask-user-question`;
const FIXTURE_PATH = `${CHECKOUT_ROOT}/tests/fixtures/hosted-synthetic-provider.ts`;
const PACKAGE_COMPOSITION_PREFIX = "hosted:package-composition:";
const PACKAGE_PROVIDER_INVENTORY_PREFIX = "hosted:package-provider-inventory:", PACKAGE_PROVIDER_INVENTORY_MAX = 4_000;
const BUILTIN_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"] as const;
const PROBE_COMMAND = "hosted-questionnaire-inventory-v1";
const PROBE_PROMPT_ID = "hosted-questionnaire-inventory-prompt-1";
const PROBE_INVENTORY_PREFIX = "hosted:questionnaire-inventory:";
const PROBE_INVENTORY_MAX = 8_000;
const PROVIDER_ENTRY_PREFIX = "hosted:questionnaire-provider-entry:";
const HOSTED_OWNER_PROFILES = ["gentle-pi", "missing", "legacy-external"] as const;
const HOSTED_PROBE_MODES = ["none", "inventory-negative"] as const;
type HostedOwnerProfile = (typeof HOSTED_OWNER_PROFILES)[number];
type HostedProbeMode = (typeof HOSTED_PROBE_MODES)[number];
const PROMPT_PROJECTION_PREFIX = "hosted:rpiv:ask-user:prompt:projection:";
const SCHEMA_PROJECTION_PREFIX = "hosted:ask_user_question:schema:";
const RELOAD_TELEMETRY_PREFIX = "hosted:reload-telemetry:";
const PUBLIC_TOOL_CALL_MARKER = "hosted:ask_user_question:tool_call";
const VALIDATION_ERROR_MARKER = "hosted:ask_user_question:validation-error";
const SCHEMA_NOTIFICATION_MAX = 24_000;
const MARKERS = [
	"hosted:session_start",
	"hosted:before_agent_start",
	"hosted:ask_user_question:registered",
	"hosted:ask_user_question:invoked",
	"hosted:ask_user_question:cancelled",
	"hosted:rpiv:ask-user:prompt",
	"hosted:rpiv:ask-user:blocked:true",
	"hosted:rpiv:ask-user:blocked:false",
];

type RpcRecord = Record<string, unknown>;
type ExitStatus = { code: number | null; signal: NodeJS.Signals | null };
type HostedScenario =
	| "cancel" | "single" | "custom" | "multi" | "empty-multi" | "partial-cancel" | "schema-positive"
	| "invalid-missing-questions" | "invalid-empty-questions" | "invalid-one-option";
type InvalidScenario = "invalid-missing-questions" | "invalid-empty-questions" | "invalid-one-option";
type AnsweredScenario = Exclude<HostedScenario, "cancel" | "partial-cancel" | "schema-positive" | InvalidScenario>;
type RunResult = { events: RpcRecord[]; cancellationResponses: number; childPid: number };
type HostedCase = { name: "owned" | "reference"; candidatePath: string; expectedSourcePath?: string; reference: boolean; scenario: HostedScenario };
type HostedPackageCase = "external-only" | "candidate-only" | "candidate-external-filtered";
type HostedPackageEntry = { source: string; extensions: string[]; skills: string[]; prompts: string[]; themes: string[] };
type HostedPackageSettings = { packages: HostedPackageEntry[]; extensions: string[]; skills: string[]; prompts: string[]; themes: string[] };
type HostedPackageProfile = { packages: HostedPackageEntry[]; root: { extensions: string[]; skills: string[]; prompts: string[]; themes: string[] } };
type StableResult = { content: unknown; details: { cancelled: unknown; answers: unknown } };
type ComparableResult = { result: StableResult; promptProjection: RpcRecord; blocked: boolean[] };

type PiPackage = { name?: string; version?: string; bin?: string | Record<string, string> };
type SchemaComparison = { name: "owned" | "reference"; schema: RpcRecord };
type InvalidClassification = { schedulerStart: number; publicToolCall: number; executionEnd: number; executionError: boolean; toolResultError: boolean; dialogs: number; prompt: number; blocked: boolean[]; validationError: number; promptSuccess: boolean; agentSettled: number; finalStop: boolean; publicErrorText: boolean };
type InvalidComparison = { name: "owned" | "reference"; classification: InvalidClassification };

function isInvalidScenario(scenario: HostedScenario): scenario is InvalidScenario {
	return scenario.startsWith("invalid-");
}

function record(value: unknown, label: string): RpcRecord { assert.ok(value !== null && typeof value === "object" && !Array.isArray(value), label); return value as RpcRecord; }

function mountOptions(mountPoint: string): string[] { const line = readFileSync("/proc/self/mountinfo", "utf8").split("\n").find((candidate) => candidate.split(" - ")[0]?.split(" ")[4] === mountPoint); assert.ok(line, `missing mount readback for ${mountPoint}`); return line.split(" - ")[0]!.split(" ")[5]!.split(","); }

function assertHostedIsolation(reference: boolean): void {
	assert.match(process.version, /^v24\./); assert.equal(process.env.GENTLE_PI_HOSTED_ISOLATION, ISOLATION_MARKER); assert.equal(process.getuid?.(), 1000);
	assert.ok(mountOptions("/").includes("ro"), "root filesystem must be read-only"); assert.ok(mountOptions(CHECKOUT_ROOT).includes("ro"), "checkout mount must be read-only");
	if (reference) assert.ok(mountOptions(REFERENCE_ROOT).includes("ro"), "reference mount must be read-only");
	const status = readFileSync("/proc/self/status", "utf8"); assert.match(status, /^NoNewPrivs:\s+1$/m); assert.match(status, /^CapEff:\s+0+$/m);
	assert.deepEqual(Object.keys(networkInterfaces()).filter((name) => name !== "lo"), []);
}

function resolvePiCli(repoRoot: string): string {
	const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")), packageRoot = dirname(dirname(entry));
	const metadata = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as PiPackage;
	assert.equal(metadata.name, "@earendil-works/pi-coding-agent"); assert.equal(metadata.version, "0.85.1");
	const bin = typeof metadata.bin === "string" ? metadata.bin : metadata.bin?.pi;
	if (typeof bin !== "string") throw new Error("Pi package has no public pi bin");
	assert.equal(bin, "dist/bundle/cli.js"); const cliPath = resolve(packageRoot, bin);
	assert.ok(relative(repoRoot, cliPath).startsWith("node_modules")); return cliPath;
}

function hostedPackageEntry(source: string, extensions: string[]): HostedPackageEntry {
	return { source, extensions, skills: [], prompts: [], themes: [] };
}

function hostedPackageSettings(packageCase: HostedPackageCase): HostedPackageSettings {
	const candidate = hostedPackageEntry(CHECKOUT_ROOT, ["extensions/ask-user-question.ts"]);
	const external = hostedPackageEntry(REFERENCE_PACKAGE_ROOT, ["index.ts"]);
	const packages = packageCase === "external-only"
		? [external]
		: packageCase === "candidate-only"
			? [candidate]
			: [candidate, hostedPackageEntry(REFERENCE_PACKAGE_ROOT, [])];
	return { packages, extensions: [FIXTURE_PATH], skills: [], prompts: [], themes: [] };
}

function packageComposition(events: RpcRecord[]): RpcRecord {
	const messages = notificationMessages(events).filter((message) => message.startsWith(PACKAGE_COMPOSITION_PREFIX));
	assert.equal(messages.length, 1);
	const encoded = messages[0]!.slice(PACKAGE_COMPOSITION_PREFIX.length);
	assert.ok(encoded.length <= 8_000, "package composition telemetry must stay bounded");
	return record(JSON.parse(encoded), "package composition");
}
function packageProviderInventories(events: RpcRecord[]): RpcRecord[] {
	const messages = notificationMessages(events).filter((message) => message.startsWith(PACKAGE_PROVIDER_INVENTORY_PREFIX)); assert.equal(messages.length, 2, "package mode must expose one provider inventory for each request");
	return messages.map((message) => { const encoded = message.slice(PACKAGE_PROVIDER_INVENTORY_PREFIX.length); assert.ok(encoded.length <= PACKAGE_PROVIDER_INVENTORY_MAX, "provider context telemetry must stay bounded"); return record(JSON.parse(encoded), "provider context inventory"); });
}

function notificationCount(events: RpcRecord[], message: string): number {
	return events.filter((event) => event.type === "extension_ui_request" && event.method === "notify" && event.message === message).length;
}

function notificationMessages(events: RpcRecord[]): string[] {
	return events.filter((event) => event.type === "extension_ui_request" && event.method === "notify")
		.map((event) => event.message).filter((message): message is string => typeof message === "string");
}

function reloadTelemetryEvent(event: RpcRecord): RpcRecord | undefined {
	if (event.type !== "extension_ui_request" || event.method !== "notify" || typeof event.message !== "string" || !event.message.startsWith(RELOAD_TELEMETRY_PREFIX)) return undefined;
	const encoded = event.message.slice(RELOAD_TELEMETRY_PREFIX.length);
	assert.ok(encoded.length <= 2_000, "reload telemetry must stay bounded");
	return record(JSON.parse(encoded), "reload telemetry");
}

function reloadTelemetry(events: RpcRecord[]): RpcRecord[] {
	return events.flatMap((event) => {
		const telemetry = reloadTelemetryEvent(event);
		return telemetry === undefined ? [] : [telemetry];
	});
}

function telemetryIndexes(events: RpcRecord[], predicate: (telemetry: RpcRecord) => boolean): number[] {
	return events.flatMap((event, index) => {
		const telemetry = reloadTelemetryEvent(event);
		return telemetry !== undefined && predicate(telemetry) ? [index] : [];
	});
}

function assertPromptProjection(value: unknown): RpcRecord {
	const projection = record(value, "prompt projection");
	assert.deepEqual(Object.keys(projection).sort(), ["questions"]);
	assert.ok(Array.isArray(projection.questions));
	for (const rawQuestion of projection.questions as unknown[]) {
		const question = record(rawQuestion, "prompt projection question");
		assert.deepEqual(Object.keys(question).sort(), ["header", "multiSelect", "options", "question"]);
		assert.equal(typeof question.question, "string"); assert.equal(typeof question.header, "string"); assert.equal(typeof question.multiSelect, "boolean");
		assert.ok(Array.isArray(question.options));
		for (const rawOption of question.options as unknown[]) {
			const option = record(rawOption, "prompt projection option");
			assert.deepEqual(Object.keys(option).sort(), ["description", "hasPreview", "label"]);
			assert.equal(typeof option.label, "string"); assert.equal(typeof option.description, "string"); assert.equal(typeof option.hasPreview, "boolean");
		}
	}
	return projection;
}

function promptProjection(events: RpcRecord[]): RpcRecord {
	const messages = notificationMessages(events).filter((message) => message.startsWith(PROMPT_PROJECTION_PREFIX));
	assert.equal(messages.length, 1);
	return assertPromptProjection(JSON.parse(messages[0]!.slice(PROMPT_PROJECTION_PREFIX.length)));
}

function schemaProjection(events: RpcRecord[]): RpcRecord {
	const messages = notificationMessages(events).filter((message) => message.startsWith(SCHEMA_PROJECTION_PREFIX));
	assert.equal(messages.length, 1);
	const encoded = messages[0]!.slice(SCHEMA_PROJECTION_PREFIX.length);
	assert.ok(encoded.length <= SCHEMA_NOTIFICATION_MAX, "schema notification must stay within the fixture bound");
	return record(JSON.parse(encoded), "public tool schema");
}

function schemaProperty(schema: RpcRecord, key: string, label: string): RpcRecord {
	return record(record(schema.properties, `${label} properties`)[key], `${label}.${key}`);
}

function assertSchemaObject(schema: RpcRecord, label: string, required: string[], properties: string[], owned: boolean): void {
	assert.equal(schema.type, "object", `${label} must be an object schema`);
	assert.deepEqual(Object.keys(record(schema.properties, `${label} properties`)).sort(), [...properties].sort(), `${label} properties`);
	const requiredFields = schema.required;
	assert.ok(Array.isArray(requiredFields), `${label} required fields must be an array`);
	assert.deepEqual([...requiredFields].sort(), [...required].sort(), `${label} required fields`);
	if (owned) assert.equal(schema.additionalProperties, false, `${label} must reject additional properties`);
	else assert.equal(Object.hasOwn(schema, "additionalProperties"), false, `${label} reference strictness boundary changed`);
}

function assertQuestionnaireSchema(schema: RpcRecord, label: string, owned: boolean): void {
	assertSchemaObject(schema, label, ["questions"], ["questions"], owned);
	const questions = schemaProperty(schema, "questions", label);
	assert.equal(questions.type, "array"); assert.equal(questions.minItems, 1); assert.equal(questions.maxItems, 4);
	const question = record(questions.items, `${label}.questions.items`);
	assertSchemaObject(question, `${label}.question`, ["question", "header", "options"], ["question", "header", "options", "multiSelect"], owned);
	assert.equal(schemaProperty(question, "question", `${label}.question`).type, "string");
	const header = schemaProperty(question, "header", `${label}.question`);
	assert.equal(header.type, "string"); assert.equal(header.maxLength, 16);
	const options = schemaProperty(question, "options", `${label}.question`);
	assert.equal(options.type, "array"); assert.equal(options.minItems, 2); assert.equal(options.maxItems, 4);
	const option = record(options.items, `${label}.question.options.items`);
	assertSchemaObject(option, `${label}.option`, ["label", "description"], ["label", "description", "preview"], owned);
	const labelSchema = schemaProperty(option, "label", `${label}.option`);
	assert.equal(labelSchema.type, "string"); assert.equal(labelSchema.maxLength, 60);
	assert.equal(schemaProperty(option, "description", `${label}.option`).type, "string");
	assert.equal(schemaProperty(option, "preview", `${label}.option`).type, "string");
	const multiSelect = schemaProperty(question, "multiSelect", `${label}.question`);
	assert.equal(multiSelect.type, "boolean");
	if (owned) assert.equal(Object.hasOwn(multiSelect, "default"), false);
	else assert.equal(multiSelect.default, false, "reference multiSelect default boundary changed");
}

function stripSchemaDescriptions(value: unknown, propertyMap = false): unknown {
	if (Array.isArray(value)) return value.map((child) => stripSchemaDescriptions(child));
	if (value !== null && typeof value === "object") {
		const result: RpcRecord = {};
		for (const [key, child] of Object.entries(value)) {
			if (key === "description" && !propertyMap) continue;
			result[key] = stripSchemaDescriptions(child, !propertyMap && key === "properties");
		}
		return result;
	}
	return value;
}

type SchemaDifference = { path: string; owned: unknown; reference: unknown };
function schemaDifferences(owned: unknown, reference: unknown, path = "", differences: SchemaDifference[] = []): SchemaDifference[] {
	if (Array.isArray(owned) && Array.isArray(reference)) {
		if (owned.length !== reference.length) differences.push({ path, owned: owned.length, reference: reference.length });
		for (let index = 0; index < Math.min(owned.length, reference.length); index += 1) schemaDifferences(owned[index], reference[index], `${path}[${index}]`, differences);
		return differences;
	}
	const ownedObject = owned !== null && typeof owned === "object" && !Array.isArray(owned);
	const referenceObject = reference !== null && typeof reference === "object" && !Array.isArray(reference);
	if (ownedObject && referenceObject) {
		const keys = new Set([...Object.keys(owned as RpcRecord), ...Object.keys(reference as RpcRecord)]);
		for (const key of [...keys].sort()) {
			const childPath = path ? `${path}.${key}` : key;
			if (!Object.hasOwn(owned as RpcRecord, key) || !Object.hasOwn(reference as RpcRecord, key)) differences.push({ path: childPath, owned: (owned as RpcRecord)[key], reference: (reference as RpcRecord)[key] });
			else schemaDifferences((owned as RpcRecord)[key], (reference as RpcRecord)[key], childPath, differences);
		}
		return differences;
	}
	if (owned !== reference) differences.push({ path, owned, reference });
	return differences;
}

function assertSchemaCompatibility(owned: RpcRecord, reference: RpcRecord): void {
	const differences = schemaDifferences(stripSchemaDescriptions(owned), stripSchemaDescriptions(reference)).sort((left, right) => left.path.localeCompare(right.path));
	// The pinned 2.9.0 reference exports Type.Object without additionalProperties and gives optional multiSelect a false default; keep both as explicit compatibility boundaries.
	assert.deepEqual(differences, [
		{ path: "additionalProperties", owned: false, reference: undefined },
		{ path: "properties.questions.items.additionalProperties", owned: false, reference: undefined },
		{ path: "properties.questions.items.properties.multiSelect.default", owned: undefined, reference: false },
		{ path: "properties.questions.items.properties.options.items.additionalProperties", owned: false, reference: undefined },
	].sort((left, right) => left.path.localeCompare(right.path)), "owned/reference schema compatibility boundary changed");
}

function resultText(value: unknown, label: string): string {
	const content = record(value, label).content;
	assert.ok(Array.isArray(content), `${label} content must be an array`);
	const text = (content as unknown[]).map((block) => record(block, `${label} content block`).text).filter((item): item is string => typeof item === "string").join("\n");
	assert.ok(text.trim().length > 0, `${label} must expose non-empty public error text`);
	assert.doesNotMatch(text, /SyntaxError|ReferenceError|TypeError|Cannot find module|ERR_MODULE_NOT_FOUND|jiti|loader|compile|transpil|stack trace/i, `${label} must not be a compiler or loader failure`);
	return text;
}

function assertInvalidRun(events: RpcRecord[], scenario: InvalidScenario): InvalidClassification {
	const suppressed = new Set([CANCELLED_MARKER, COMPLETED_MARKER, MARKERS[5]!, MARKERS[6]!, MARKERS[7]!]);
	for (const marker of MARKERS) assert.equal(notificationCount(events, marker), suppressed.has(marker) ? 0 : 1, marker);
	assert.equal(notificationCount(events, PUBLIC_TOOL_CALL_MARKER), 0);
	assert.equal(notificationCount(events, COMPLETED_MARKER), 0);
	assert.equal(notificationCount(events, VALIDATION_ERROR_MARKER), 1);
	const dialogs = events.filter((event) => event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(String(event.method)));
	assert.deepEqual(dialogs, [], `${scenario} must not request questionnaire UI`);
	assert.equal(events.filter((event) => event.type === "tool_execution_start" && event.toolName === TOOL_NAME).length, 1);
	const toolEnds = events.filter((event) => event.type === "tool_execution_end" && event.toolName === TOOL_NAME);
	assert.equal(toolEnds.length, 1); assert.equal(toolEnds[0]!.isError, true);
	const executionErrorText = resultText(toolEnds[0]!.result, `${scenario} public execution error`);
	const messages = events.filter((event) => event.type === "message_end").map((event) => record(event.message, "message_end message"));
	const toolResult = messages.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
	assert.ok(toolResult); assert.equal(toolResult.isError, true); const toolResultErrorText = resultText(toolResult, `${scenario} public tool-result error`);
	const promptResponses = events.filter((event) => event.type === "response" && event.command === "prompt");
	assert.equal(promptResponses.length, 1); assert.equal(promptResponses[0]!.success, true);
	const assistants = messages.filter((message) => message.role === "assistant");
	assert.ok(assistants.length >= 2); const finalAssistant = assistants[assistants.length - 1]!; assert.equal(finalAssistant.stopReason, "stop");
	const finalContent = Array.isArray(finalAssistant.content) ? finalAssistant.content : [];
	assert.ok(finalContent.some((block) => record(block, `${scenario} final assistant content`).text === FINAL_TEXT[scenario]));
	const agentSettled = events.filter((event) => event.type === "agent_settled").length;
	assert.equal(agentSettled, 1);
	return {
		schedulerStart: events.filter((event) => event.type === "tool_execution_start" && event.toolName === TOOL_NAME).length,
		publicToolCall: notificationCount(events, PUBLIC_TOOL_CALL_MARKER), executionEnd: toolEnds.length, executionError: toolEnds[0]!.isError === true,
		toolResultError: toolResult.isError === true, dialogs: dialogs.length, prompt: notificationCount(events, MARKERS[5]!), blocked: [notificationCount(events, MARKERS[6]!) > 0, notificationCount(events, MARKERS[7]!) > 0],
		validationError: notificationCount(events, VALIDATION_ERROR_MARKER), promptSuccess: promptResponses[0]!.success === true, agentSettled, finalStop: finalAssistant.stopReason === "stop", publicErrorText: executionErrorText.trim().length > 0 && toolResultErrorText.trim().length > 0,
	};
}

function blockedSequence(events: RpcRecord[]): boolean[] {
	const sequence = notificationMessages(events).flatMap((message) => message === MARKERS[6] ? [true] : message === MARKERS[7] ? [false] : []);
	assert.deepEqual(sequence, [true, false]);
	return sequence;
}

function expectedPackageProfile(packageCase: HostedPackageCase): HostedPackageProfile {
	const settings = hostedPackageSettings(packageCase);
	return {
		packages: settings.packages,
		root: { extensions: settings.extensions, skills: settings.skills, prompts: settings.prompts, themes: settings.themes },
	};
}

function ownerConfigText(owner: Exclude<HostedOwnerProfile, "missing">): string {
	return `${JSON.stringify({ schema: "gentle-pi.question-owner/v1", owner })}\n`;
}

function probeInventory(events: RpcRecord[]): RpcRecord {
	const messages = notificationMessages(events).filter((message) => message.startsWith(PROBE_INVENTORY_PREFIX));
	assert.equal(messages.length, 1, "negative owner probe must emit exactly one inventory notification");
	const encoded = messages[0]!.slice(PROBE_INVENTORY_PREFIX.length);
	assert.ok(encoded.length <= PROBE_INVENTORY_MAX, "negative owner probe inventory must stay bounded");
	return record(JSON.parse(encoded), "negative owner probe inventory");
}

function assertHostedNegativeProbe(events: RpcRecord[], ownerProfile: Exclude<HostedOwnerProfile, "gentle-pi">): void {
	const inventory = probeInventory(events);
	assert.deepEqual(Object.keys(inventory).sort(), ["activeToolNames", "catalog", "fixturePath", "hasUI", "mode", "ownerState", "providerStreamCalls", "questionnaire", "questionnaireCount", "settingsProfile"]);
	assert.equal(inventory.mode, "rpc");
	assert.equal(inventory.hasUI, true);
	const catalog = inventory.catalog;
	assert.ok(Array.isArray(catalog));
	assert.deepEqual(catalog.map((entry, index) => record(entry, `negative catalog entry ${index}`).name), [...BUILTIN_TOOL_NAMES]);
	for (const [index, rawEntry] of catalog.entries()) {
		const entry = record(rawEntry, `negative catalog entry ${index}`);
		assert.deepEqual(Object.keys(entry).sort(), ["name", "sourceInfo"]);
		const sourceInfo = record(entry.sourceInfo, `negative catalog source info ${index}`);
		assert.deepEqual(Object.keys(sourceInfo).sort(), ["path", "source"]);
		assert.equal(typeof sourceInfo.path, "string");
		assert.equal(sourceInfo.source, "builtin");
	}
	assert.deepEqual(inventory.activeToolNames, []);
	assert.equal(inventory.questionnaireCount, 0);
	assert.deepEqual(inventory.questionnaire, []);
	assert.deepEqual(inventory.settingsProfile, expectedPackageProfile("candidate-only"));
	assert.equal(inventory.fixturePath, FIXTURE_PATH);
	assert.equal(inventory.providerStreamCalls, 0);
	assert.deepEqual(inventory.ownerState, ownerProfile === "missing"
		? { state: "missing" }
		: { state: "present", content: ownerConfigText(ownerProfile) });

	const forbiddenNotifications = notificationMessages(events).filter((message) => [
		MARKERS[2]!, MARKERS[3]!, MARKERS[4]!, MARKERS[5]!, MARKERS[6]!, MARKERS[7]!, COMPLETED_MARKER,
		PUBLIC_TOOL_CALL_MARKER, VALIDATION_ERROR_MARKER,
	].some((marker) => message === marker)
		|| message.startsWith(PROMPT_PROJECTION_PREFIX)
		|| message.startsWith(SCHEMA_PROJECTION_PREFIX)
		|| message.startsWith(PACKAGE_COMPOSITION_PREFIX)
		|| message.startsWith(PACKAGE_PROVIDER_INVENTORY_PREFIX)
		|| message.startsWith(PROVIDER_ENTRY_PREFIX)
		|| message.startsWith(RELOAD_TELEMETRY_PREFIX));
	assert.deepEqual(forbiddenNotifications, []);
	const dialogs = events.filter((event) => event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(String(event.method)));
	assert.deepEqual(dialogs, []);
	assert.deepEqual(events.filter((event) => event.type === "tool_execution_start" || event.type === "tool_execution_end"), []);
	assert.deepEqual(events.filter((event) => event.type === "agent_settled"), []);
	const providerMessages = events.filter((event) => {
		if (event.type !== "message_end" || event.message === null || typeof event.message !== "object") return false;
		const message = event.message as RpcRecord;
		return message.role === "assistant" || message.role === "toolResult";
	});
	assert.deepEqual(providerMessages, []);
	const responses = events.filter((event) => event.type === "response");
	assert.deepEqual(responses.map((event) => ({ id: event.id, command: event.command, success: event.success })), [{ id: PROBE_PROMPT_ID, command: "prompt", success: true }]);
}

function assertHostedPackageComposition(events: RpcRecord[], packageCase: HostedPackageCase, expectedSourcePath: string): void {
	const composition = packageComposition(events);
	assert.deepEqual(Object.keys(composition).sort(), ["inventory", "packageCase", "profile"]);
	assert.equal(composition.packageCase, packageCase);
	assert.deepEqual(composition.profile, expectedPackageProfile(packageCase));
	const inventory = record(composition.inventory, "package tool inventory");
	assert.deepEqual(Object.keys(inventory).sort(), ["activeToolNames", "allToolNames", "builtinToolNames", "otherTools", "questionnaire", "questionnaireCount", "sdkToolNames"]);
	assert.deepEqual(inventory.allToolNames, [...BUILTIN_TOOL_NAMES, TOOL_NAME]); assert.deepEqual(inventory.activeToolNames, [TOOL_NAME]);
	assert.deepEqual(inventory.builtinToolNames, [...BUILTIN_TOOL_NAMES]); assert.deepEqual(inventory.sdkToolNames, []);
	assert.equal(inventory.questionnaireCount, 1); assert.deepEqual(inventory.questionnaire, [{ name: TOOL_NAME, sourceInfoPath: expectedSourcePath }]);
	assert.ok(Array.isArray(inventory.otherTools)); assert.equal(inventory.otherTools.length, 1);
	const otherTool = record(inventory.otherTools[0], "other package tool"); assert.deepEqual(Object.keys(otherTool).sort(), ["name", "sourceInfo"]); assert.equal(otherTool.name, TOOL_NAME);
	const sourceInfo = record(otherTool.sourceInfo, "other package tool provenance"); assert.deepEqual(Object.keys(sourceInfo).sort(), ["path", "source"]);
	assert.equal(typeof sourceInfo.path, "string"); assert.equal(sourceInfo.path, expectedSourcePath); assert.equal(typeof sourceInfo.source, "string");
	assert.notEqual(sourceInfo.source, "builtin"); assert.notEqual(sourceInfo.source, "sdk");
}

function assertHostedPackageCancellation(events: RpcRecord[]): void {
	for (const inventory of packageProviderInventories(events)) {
		assert.deepEqual(Object.keys(inventory).sort(), ["toolCallId", "toolNames"]); assert.equal(inventory.toolCallId, "hosted-questionnaire-call-1"); assert.deepEqual(inventory.toolNames, [TOOL_NAME]);
	}
	for (const marker of MARKERS) assert.equal(notificationCount(events, marker), 1, marker);
	assert.equal(notificationCount(events, PUBLIC_TOOL_CALL_MARKER), 1);
	assert.equal(notificationCount(events, VALIDATION_ERROR_MARKER), 0);
	assert.equal(notificationCount(events, COMPLETED_MARKER), 0);
	const dialogs = events.filter((event) => event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(String(event.method)));
	assert.deepEqual(dialogs.map((event) => event.method), ["select"]);
	const promptResponses = events.filter((event) => event.type === "response" && event.command === "prompt");
	assert.deepEqual(promptResponses.map((event) => event.success), [true]);
	const toolEnds = events.filter((event) => event.type === "tool_execution_end" && event.toolName === TOOL_NAME);
	assert.equal(toolEnds.length, 1);
	assert.equal(toolEnds[0]!.isError, false);
	const execution = record(toolEnds[0]!.result, "package tool execution result");
	assert.deepEqual(execution.content, [{ type: "text", text: DECLINE_MESSAGE }]);
	assert.deepEqual(record(execution.details, "package tool execution details"), { answers: [], cancelled: true });
	const messages = events.filter((event) => event.type === "message_end").map((event) => record(event.message, "package message_end message"));
	const toolResult = messages.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
	assert.ok(toolResult);
	assert.equal(toolResult.isError, false);
	assert.deepEqual(toolResult.content, [{ type: "text", text: DECLINE_MESSAGE }]);
	assert.deepEqual(record(toolResult.details, "package tool result details"), { answers: [], cancelled: true });
	const assistants = messages.filter((message) => message.role === "assistant");
	assert.ok(assistants.length >= 2);
	const finalAssistant = assistants[assistants.length - 1]!;
	assert.equal(finalAssistant.stopReason, "stop");
	const finalContent = Array.isArray(finalAssistant.content) ? finalAssistant.content : [];
	assert.ok(finalContent.some((block) => record(block, "package final assistant content").text === FINAL_TEXT.cancel));
	assert.equal(events.filter((event) => event.type === "agent_settled").length, 1);
	assert.deepEqual(promptProjection(events), expectedPromptProjection("cancel"));
	assert.deepEqual(blockedSequence(events), [true, false]);
}

function expectedPromptProjection(scenario: HostedScenario): RpcRecord {
	const multi = scenario === "multi" || scenario === "empty-multi";
	const layoutOptions = multi
		? [
			{ label: "Compact", description: "Use a compact layout.", hasPreview: false },
			{ label: "Detailed", description: "Use a detailed layout.", hasPreview: false },
			{ label: "Spacious", description: "Use a spacious layout.", hasPreview: false },
		]
		: [
			{ label: "Compact", description: "Use a compact layout.", hasPreview: false },
			{ label: "Detailed", description: "Use a detailed layout.", hasPreview: false },
		];
	const questions: RpcRecord[] = [{ question: QUESTION, header: "Layout", multiSelect: multi, options: layoutOptions }];
	if (scenario === "schema-positive") return {
		questions: [
			questions[0]!,
			{ question: SECOND_QUESTION, header: "Spacing", multiSelect: false, options: [
				{ label: "Dense", description: "Use tighter spacing.", hasPreview: false },
				{ label: "Relaxed", description: "Use more generous spacing.", hasPreview: false },
			] },
			{ question: THIRD_QUESTION, header: "Compare", multiSelect: true, options: [
				{ label: "Compact", description: "Compare the compact option.", hasPreview: true },
				{ label: "Detailed", description: "Compare the detailed option.", hasPreview: false },
			] },
		],
	};
	if (scenario === "partial-cancel") {
		questions.push({
			question: SECOND_QUESTION,
			header: "Spacing",
			multiSelect: false,
			options: [
				{ label: "Dense", description: "Use tighter spacing.", hasPreview: false },
				{ label: "Relaxed", description: "Use more generous spacing.", hasPreview: false },
			],
		});
	}
	return { questions };
}

function expectedAnswer(scenario: AnsweredScenario): RpcRecord {
	if (scenario === "single") return { questionIndex: 0, question: QUESTION, kind: "option", answer: "Compact" };
	if (scenario === "custom") return { questionIndex: 0, question: QUESTION, kind: "custom", answer: CUSTOM_ANSWER };
	return {
		questionIndex: 0,
		question: QUESTION,
		kind: "multi",
		answer: null,
		selected: scenario === "multi" ? ["Compact", "Detailed"] : [],
	};
}

function expectedAnswers(scenario: HostedScenario): RpcRecord[] {
	if (scenario === "cancel" || scenario === "schema-positive" || isInvalidScenario(scenario)) return [];
	if (scenario === "partial-cancel") return [expectedAnswer("single")];
	return [expectedAnswer(scenario)];
}

function successfulContent(answer: string): string {
	return `User has answered your questions: "${QUESTION}"="${answer}". You can now continue with the user's answers in mind.`;
}

function expectedContent(scenario: HostedScenario): string {
	if (scenario === "cancel" || scenario === "partial-cancel" || scenario === "schema-positive" || isInvalidScenario(scenario)) return DECLINE_MESSAGE;
	const answer = expectedAnswer(scenario);
	const scalar = answer.kind === "multi"
		? Array.isArray(answer.selected) && answer.selected.length > 0 ? answer.selected.join(", ") : "(no input)"
		: typeof answer.answer === "string" ? answer.answer : "(no input)";
	return successfulContent(scalar);
}

function assertSuccessfulResult(content: unknown, details: RpcRecord, scenario: AnsweredScenario): void {
	assert.deepEqual(Object.keys(details).sort(), ["answers", "cancelled"]);
	assert.equal(details.cancelled, false);
	assert.deepEqual(details.answers, expectedAnswers(scenario));
	assert.deepEqual(content, [{ type: "text", text: expectedContent(scenario) }]);
}

function assertPartialCancelledResult(content: unknown, details: RpcRecord): void {
	assert.deepEqual(Object.keys(details).sort(), ["answers", "cancelled"]);
	assert.equal(details.cancelled, true);
	assert.deepEqual(details.answers, expectedAnswers("partial-cancel"));
	assert.deepEqual(content, [{ type: "text", text: DECLINE_MESSAGE }]);
}

function assertReloadToolResult(events: RpcRecord[], generation: number): void {
	const toolCallId = `hosted-questionnaire-call-${generation}`;
	const messages = events.filter((event) => event.type === "message_end").map((event) => record(event.message, "reload message_end message"));
	const toolCalls = messages.flatMap((message) => message.role === "assistant" && Array.isArray(message.content) ? message.content : []).map((block) => record(block, "reload assistant content block"));
	const matchingCalls = toolCalls.filter((block) => block.type === "toolCall" && block.name === TOOL_NAME && block.id === toolCallId);
	assert.equal(matchingCalls.length, 1);
	const toolCall = matchingCalls[0]!;
	assert.equal(typeof toolCall.id, "string");
	assert.equal(toolCall.id, toolCallId);
	const toolResults = messages.filter((message) => message.role === "toolResult" && message.toolName === TOOL_NAME && message.toolCallId === toolCallId);
	assert.equal(toolResults.length, 1, `generation ${generation} must have one matching public tool result`);
	const toolResult = toolResults[0]!;
	assert.equal(typeof toolResult.toolCallId, "string");
	assert.equal(toolResult.isError, false);
	assert.deepEqual(toolResult.content, [{ type: "text", text: DECLINE_MESSAGE }]);
	assert.deepEqual(record(toolResult.details, "reload tool result details"), { answers: [], cancelled: true });
	const starts = events.filter((event) => event.type === "tool_execution_start" && event.toolName === TOOL_NAME && event.toolCallId === toolCallId);
	const calls = reloadTelemetry(events).filter((event) => event.event === "tool_callback" && event.phase === "call" && event.generation === generation && event.toolCallId === toolCallId);
	const ends = events.filter((event) => event.type === "tool_execution_end" && event.toolName === TOOL_NAME && event.toolCallId === toolCallId);
	assert.equal(starts.length, 1); assert.equal(calls.length, 1); assert.equal(ends.length, 1);
	assert.equal(ends[0]!.isError, false);
	assert.deepEqual(record(ends[0]!.result, "reload execution result").content, [{ type: "text", text: DECLINE_MESSAGE }]);
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => rejectPromise(new Error(`${label} timed out`)), milliseconds);
		promise.then((value) => { clearTimeout(timer); resolvePromise(value); }, (error) => { clearTimeout(timer); rejectPromise(error); });
	});
}

async function runRpc(cliPath: string, candidatePath: string, fixturePath: string, sandbox: string, expectedSourcePath?: string, scenario: HostedScenario = "cancel", reload = false, packageCase?: HostedPackageCase, ownerProfile: HostedOwnerProfile = "gentle-pi", probeMode: HostedProbeMode = "none"): Promise<RunResult> {
	assert.ok(candidatePath === OWNED_EXTENSION_PATH || candidatePath === REFERENCE_EXTENSION_PATH, `unsupported hosted questionnaire candidate: ${candidatePath}`);
	assert.ok((HOSTED_OWNER_PROFILES as readonly string[]).includes(ownerProfile), `unsupported hosted owner profile: ${ownerProfile}`);
	assert.ok((HOSTED_PROBE_MODES as readonly string[]).includes(probeMode), `unsupported hosted probe mode: ${probeMode}`);
	if (probeMode !== "none") {
		assert.equal(packageCase, "candidate-only"); assert.notEqual(ownerProfile, "gentle-pi"); assert.equal(scenario, "cancel"); assert.equal(reload, false);
	}
	assert.equal(fixturePath, FIXTURE_PATH);
	assert.equal(expectedSourcePath, candidatePath === REFERENCE_EXTENSION_PATH ? REFERENCE_EXTENSION_PATH : undefined);
	const dirs = ["home", "profile", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "xdg-runtime", "tmp", "agent", "sessions", "cwd"];
	await Promise.all(dirs.map((name) => mkdir(join(sandbox, name), { recursive: true })));
	const ownerPath = join(sandbox, "agent", "gentle-ai", "question-owner.json");
	if (ownerProfile === "missing") {
		await assert.rejects(readFile(ownerPath, "utf8"), (error: unknown) => { assert.equal((error as NodeJS.ErrnoException).code, "ENOENT"); return true; });
	} else {
		await mkdir(dirname(ownerPath), { recursive: true });
		const contents = ownerConfigText(ownerProfile);
		await writeFile(ownerPath, contents);
		assert.equal(await readFile(ownerPath, "utf8"), contents);
		assert.deepEqual(JSON.parse(contents), { schema: "gentle-pi.question-owner/v1", owner: ownerProfile });
	}
	if (packageCase !== undefined) {
		const settingsPath = join(sandbox, "agent", "settings.json");
		const settings = hostedPackageSettings(packageCase);
		await writeFile(settingsPath, `${JSON.stringify(settings)}\n`);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), settings);
	}
	const tempPath = (name: string) => join(sandbox, name);
	const childEnv: Record<string, string> = {
		PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
		HOME: tempPath("home"), USERPROFILE: tempPath("profile"),
		XDG_CONFIG_HOME: tempPath("xdg-config"), XDG_CACHE_HOME: tempPath("xdg-cache"),
		XDG_DATA_HOME: tempPath("xdg-data"), XDG_STATE_HOME: tempPath("xdg-state"), XDG_RUNTIME_DIR: tempPath("xdg-runtime"),
		TMPDIR: tempPath("tmp"), TMP: tempPath("tmp"), TEMP: tempPath("tmp"),
		PI_CODING_AGENT_DIR: tempPath("agent"), PI_CODING_AGENT_SESSION_DIR: tempPath("sessions"),
		GENTLE_PI_AGENT_HOME: tempPath("agent"), GENTLE_PI_CONFIG_HOME: tempPath("xdg-config"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
		GENTLE_PI_HOSTED_SCENARIO: scenario,
	};
	if (expectedSourcePath !== undefined) childEnv.GENTLE_PI_HOSTED_EXPECTED_SOURCE_PATH = expectedSourcePath;
	if (reload) childEnv.GENTLE_PI_HOSTED_RELOAD = "1";
	if (packageCase !== undefined) childEnv.GENTLE_PI_HOSTED_PACKAGE_CASE = packageCase;
	if (ownerProfile !== "gentle-pi") childEnv.GENTLE_PI_HOSTED_OWNER_PROFILE = ownerProfile;
	if (probeMode !== "none") childEnv.GENTLE_PI_HOSTED_PROBE_MODE = probeMode;
	assert.deepEqual(Object.keys(childEnv).sort(), ["GENTLE_PI_AGENT_HOME", "GENTLE_PI_CONFIG_HOME", "GENTLE_PI_HOSTED_SCENARIO", "HOME", "PATH", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "PI_OFFLINE", "PI_SKIP_VERSION_CHECK", "PI_TELEMETRY", "TEMP", "TMP", "TMPDIR", "USERPROFILE", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_STATE_HOME", ...(expectedSourcePath === undefined ? [] : ["GENTLE_PI_HOSTED_EXPECTED_SOURCE_PATH"]), ...(reload ? ["GENTLE_PI_HOSTED_RELOAD"] : []), ...(packageCase === undefined ? [] : ["GENTLE_PI_HOSTED_PACKAGE_CASE"]), ...(ownerProfile === "gentle-pi" ? [] : ["GENTLE_PI_HOSTED_OWNER_PROFILE"]), ...(probeMode === "none" ? [] : ["GENTLE_PI_HOSTED_PROBE_MODE"])].sort());
	for (const path of Object.values(childEnv).filter((value) => value.startsWith("/"))) {
		assert.ok(relative(CHECKOUT_ROOT, path).startsWith(".."), `child path must be outside checkout: ${path}`);
	}

	const args = packageCase === undefined
		? [cliPath, "--mode", "rpc", "--no-session", "--no-extensions", "-e", candidatePath, "-e", fixturePath, "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--no-approve", "--offline", "--model", `${PROVIDER_ID}/${MODEL_ID}`]
		: [cliPath, "--mode", "rpc", "--no-session", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files", "--no-builtin-tools", "--no-approve", "--offline", "--model", `${PROVIDER_ID}/${MODEL_ID}`];
	if (packageCase === undefined) assert.deepEqual(args.filter((arg) => arg === "-e"), ["-e", "-e"]);
	else { assert.equal(args.includes("--no-extensions"), false); assert.equal(args.includes("-e"), false); }
	const child = spawn(process.execPath, args, { cwd: tempPath("cwd"), env: childEnv, stdio: ["pipe", "pipe", "pipe"], shell: false });
	const childClosed = new Promise<void>((resolveClosed) => child.once("close", () => resolveClosed()));
	const childPid = child.pid;
	assert.ok(childPid, "hosted Pi child PID must be tracked");
	const events: RpcRecord[] = [];
	let stderr = "";
	let buffer = "";
	let cancellationResponses = 0;
	let dialogIndex = 0;
	const observedDialogMethods: string[] = [];
	let completionClaimed = false;
	let resolveCompletion!: () => void;
	let rejectCompletion!: (error: unknown) => void;
	const completion = new Promise<void>((resolvePromise, rejectPromise) => { resolveCompletion = resolvePromise; rejectCompletion = rejectPromise; });
	let settledCount = 0;
	let probeInventoryCount = 0;
	let probePromptResponseObserved = false;
	let probeInventoryIndex = -1;
	let probePromptResponseIndex = -1;
	let callbackFailure: unknown;
	let reloadResourcesObserved = false;
	let reloadResponseObserved = false;
	let reloadPromptSent = false;
	const exited = new Promise<ExitStatus>((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
	const fail = (error: unknown): void => {
		if (callbackFailure === undefined) callbackFailure = error;
		if (!completionClaimed) { completionClaimed = true; rejectCompletion(error); }
	};
	child.once("exit", (code, signal) => {
		if (!completionClaimed) fail(new Error(`Pi child exited before ${probeMode === "none" ? "settling" : "negative owner probe completion"} (${signal ?? code}); stderr: ${stderr}`));
	});
	const send = (command: RpcRecord): void => {
		if (!child.stdin || child.stdin.destroyed || child.stdin.writableEnded) throw new Error("hosted Pi stdin is not writable");
		child.stdin.write(`${JSON.stringify(command)}\n`);
	};
	const maybeResolveProbeCompletion = (): void => {
		if (probeMode === "none" || completionClaimed || !probePromptResponseObserved || probeInventoryCount !== 1) return;
		completionClaimed = true;
		resolveCompletion();
	};
	const selectStep = (matcher: (option: string) => boolean, label: string) => (event: RpcRecord): void => {
		assert.equal(event.method, "select", `${label} must use select`);
		if (!Array.isArray(event.options)) throw new Error(`${label} must expose options`);
		assert.ok(event.options.every((option): option is string => typeof option === "string"), `${label} options must be strings`);
		assert.equal(new Set(event.options).size, event.options.length, `${label} options must be unique`);
		const matches = event.options.filter((option): option is string => typeof option === "string" && matcher(option));
		assert.equal(matches.length, 1, `${label} must have one matching emitted option`);
		assert.equal(typeof event.id, "string", `${label} request must have an RPC id`);
		send({ type: "extension_ui_response", id: event.id, value: matches[0] });
	};
	const inputStep = (value: string, placeholder: string, label: string, question: string = QUESTION) => (event: RpcRecord): void => {
		assert.equal(event.method, "input", `${label} must use input`);
		assert.equal(event.placeholder, placeholder, `${label} placeholder changed`);
		assert.ok(typeof event.title === "string" && event.title.includes(question), `${label} title must name its question`);
		assert.equal(typeof event.id, "string", `${label} request must have an RPC id`);
		send({ type: "extension_ui_response", id: event.id, value });
	};
	const textStep = (methods: readonly ("editor" | "input")[], label: string) => (event: RpcRecord): void => {
		assert.ok(methods.includes(event.method as "editor" | "input"), `${label} used unexpected method ${String(event.method)}`);
		assert.equal(typeof event.id, "string", `${label} request must have an RPC id`);
		send({ type: "extension_ui_response", id: event.id, value: CUSTOM_ANSWER });
	};
	const cancelStep = (event: RpcRecord): void => {
		assert.equal(event.method, "select", "cancellation must start with select");
		if (!Array.isArray(event.options)) throw new Error("cancellation must expose options");
		assert.ok(event.options.every((option): option is string => typeof option === "string"), "cancellation options must be strings");
		assert.equal(new Set(event.options).size, event.options.length, "cancellation options must be unique");
		if (cancellationResponses >= (reload ? 2 : 1)) throw new Error("hosted questionnaire requested more than one selection dialog per invocation");
		assert.equal(typeof event.id, "string", "selection request must have an RPC id");
		cancellationResponses += 1;
		send({ type: "extension_ui_response", id: event.id, cancelled: true });
	};
	const cancelQuestion = (question: string) => (event: RpcRecord): void => {
		assert.ok(typeof event.title === "string" && event.title.includes(question), `cancellation title must name ${question}`);
		cancelStep(event);
	};
	const owned = candidatePath === OWNED_EXTENSION_PATH;
	const plannedDialogs: Array<(event: RpcRecord) => void> = (() => {
		if (probeMode !== "none") return [];
		if (isInvalidScenario(scenario)) return [];
		if (scenario === "schema-positive") return [cancelQuestion(QUESTION)];
		if (scenario === "cancel") return reload ? [cancelStep, cancelStep] : [cancelStep];
		if (scenario === "partial-cancel") {
			return owned
				? [
					selectStep((option) => option === "Choose an option", "owned partial first action"),
					selectStep((option) => option === "Compact", "owned partial first option"),
					selectStep((option) => option === "Next", "owned partial advance"),
					cancelQuestion(SECOND_QUESTION),
				]
				: [selectStep((option) => /^1\. Compact — .+$/.test(option), "reference partial first option"), cancelQuestion(SECOND_QUESTION)];
		}
		if (owned) {
			if (scenario === "single") return [selectStep((option) => option === "Choose an option", "owned single action"), selectStep((option) => option === "Compact", "owned single option"), selectStep((option) => option === "Submit", "owned single submit")];
			if (scenario === "custom") return [selectStep((option) => option === "Use custom text", "owned custom action"), textStep(["editor", "input"], "owned custom text"), selectStep((option) => option === "Submit", "owned custom submit")];
			if (scenario === "multi") return [
				selectStep((option) => option === "Choose options", "owned multi first action"),
				selectStep((option) => option === "Compact", "owned multi first option"),
				selectStep((option) => option === "Choose options", "owned multi second action"),
				selectStep((option) => option === "Detailed", "owned multi second option"),
				selectStep((option) => option === "Submit", "owned multi submit"),
			];
			return [selectStep((option) => option === "Submit", "owned empty multi submit")];
		}
		if (scenario === "single") return [selectStep((option) => /^1\. Compact — .+$/.test(option), "reference single option")];
		if (scenario === "custom") return [selectStep((option) => option === "3. Type something.", "reference custom option"), textStep(["input"], "reference custom text")];
		if (scenario === "multi") return [inputStep("1,2", "1,3", "reference multi input")];
		return [inputStep("", "1,3", "reference empty multi input")];
	})();
	const fireAndForget = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
	const onLine = (rawLine: string): void => {
		const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
		if (!line) return;
		try {
			const event = record(JSON.parse(line), "RPC stdout must contain JSON objects");
			events.push(event);
			if (probeMode !== "none") {
				if (event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(String(event.method))) throw new Error(`negative owner probe unexpectedly requested questionnaire UI: ${String(event.method)}`);
				if (event.type === "tool_call" || event.type === "tool_execution_start" || event.type === "tool_execution_end" || event.type === "provider_request" || event.type === "provider_inventory") throw new Error(`negative owner probe unexpectedly executed or requested a tool/provider: ${String(event.toolName)}`);
				if (event.type === "agent_settled") throw new Error("negative owner probe unexpectedly emitted agent_settled");
				if (event.type === "message_end" && event.message !== null && typeof event.message === "object") {
					const message = event.message as RpcRecord;
					if (message.role === "assistant" || message.role === "toolResult") throw new Error(`negative owner probe unexpectedly emitted provider message: ${String(message.role)}`);
				}
			}
			const notification = event.type === "extension_ui_request" && event.method === "notify" && typeof event.message === "string" ? event.message : undefined;
			if (probeMode !== "none" && notification !== undefined) {
				const forbidden = [
					MARKERS[2]!, MARKERS[3]!, MARKERS[4]!, MARKERS[5]!, MARKERS[6]!, MARKERS[7]!, COMPLETED_MARKER,
					PUBLIC_TOOL_CALL_MARKER, VALIDATION_ERROR_MARKER,
				].some((marker) => notification === marker)
					|| notification.startsWith(PROMPT_PROJECTION_PREFIX)
					|| notification.startsWith(SCHEMA_PROJECTION_PREFIX)
					|| notification.startsWith(PACKAGE_COMPOSITION_PREFIX)
					|| notification.startsWith(PACKAGE_PROVIDER_INVENTORY_PREFIX)
					|| notification.startsWith(PROVIDER_ENTRY_PREFIX)
					|| notification.startsWith(RELOAD_TELEMETRY_PREFIX);
				if (forbidden) throw new Error(`negative owner probe emitted forbidden notification: ${notification.slice(0, 240)}`);
				if (notification.startsWith(PROBE_INVENTORY_PREFIX)) {
					probeInventoryCount += 1;
					if (probeInventoryCount > 1) throw new Error("negative owner probe emitted more than one inventory notification");
					const encoded = notification.slice(PROBE_INVENTORY_PREFIX.length);
					assert.ok(encoded.length <= PROBE_INVENTORY_MAX, "negative owner probe inventory must stay bounded");
					record(JSON.parse(encoded), "negative owner probe inventory");
					probeInventoryIndex = events.length - 1;
					maybeResolveProbeCompletion();
				}
			}
			if (probeMode !== "none" && event.type === "response" && event.id === PROBE_PROMPT_ID) {
				assert.equal(event.command, "prompt", "negative owner probe response command changed");
				assert.equal(event.success, true, "negative owner probe prompt response must succeed");
				probePromptResponseObserved = event.success === true;
				probePromptResponseIndex = events.length - 1;
				maybeResolveProbeCompletion();
			}
			const telemetry = reload ? reloadTelemetryEvent(event) : undefined;
			if (telemetry?.event === "resources_discover" && telemetry.generation === 2 && telemetry.reason === "reload") reloadResourcesObserved = true;
			if (reload && event.type === "response" && event.id === "reload-1" && event.command === "prompt") {
				assert.equal(event.success, true, "reload command response must succeed");
				reloadResponseObserved = event.success === true;
			}
			if (event.type === "extension_ui_request") {
				if (typeof event.method !== "string") throw new Error("extension UI request method must be a string");
				if (!fireAndForget.has(event.method)) {
					const step = plannedDialogs[dialogIndex];
					if (!step) throw new Error(`unexpected or extra extension dialog: ${event.method}`);
					observedDialogMethods.push(event.method);
					step(event);
					dialogIndex += 1;
				}
			}
			if (event.type === "agent_settled") {
				settledCount += 1;
				if (!reload || settledCount === 2) { completionClaimed = true; resolveCompletion(); }
				else if (settledCount === 1) send({ id: "reload-1", type: "prompt", message: "/hosted-questionnaire-reload-v1" });
			}
			if (reload && reloadResourcesObserved && reloadResponseObserved && !reloadPromptSent) {
				reloadPromptSent = true;
				send({ id: "hosted-prompt-2", type: "prompt", message: "Use ask_user_question to choose a layout after reload; do not answer until the questionnaire is complete." });
			}
		} catch (error) { fail(error); }
	};
	const decoder = new StringDecoder("utf8");
	child.stdout?.on("data", (chunk: Buffer | string) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		let newline = buffer.indexOf("\n");
		while (newline >= 0) { onLine(buffer.slice(0, newline)); buffer = buffer.slice(newline + 1); newline = buffer.indexOf("\n"); }
	});
	child.stdout?.on("end", () => { buffer += decoder.end(); if (buffer) onLine(buffer); });
	child.stdout?.on("error", fail);
	child.stderr?.on("data", (chunk: Buffer | string) => { stderr = `${stderr}${chunk}`.slice(-4000); });
	child.stderr?.on("error", fail);
	child.stdin?.on("error", fail);
	child.once("error", fail);
	let exit: ExitStatus | undefined;
	try {
		if (probeMode === "none") send({ id: "hosted-prompt-1", type: "prompt", message: "Use ask_user_question to choose a layout; do not answer until the questionnaire is complete." });
		else send({ id: PROBE_PROMPT_ID, type: "prompt", message: `/${PROBE_COMMAND}` });
		await withTimeout(completion, 30_000, `Pi child ${childPid} completion`);
		child.stdin?.end();
		exit = await withTimeout(exited, 5_000, `Pi child ${childPid} exit`);
		await withTimeout(childClosed, 5_000, `Pi child ${childPid} close`);
		if (callbackFailure !== undefined) throw callbackFailure;
		assert.equal(exit.code, 0, `Pi child exited with ${exit.signal ?? exit.code}; stderr: ${stderr}`);
		if (probeMode === "none") assert.equal(settledCount, reload ? 2 : 1, "hosted questionnaire invocation settlement count changed");
		else {
			assert.equal(settledCount, 0, "command-only owner probe must not wait for agent_settled");
			assert.equal(probePromptResponseObserved, true, "negative owner probe prompt response was not observed");
			assert.equal(probeInventoryCount, 1, "negative owner probe inventory count changed");
			assert.ok(probeInventoryIndex < probePromptResponseIndex, "negative owner probe inventory must precede its correlated response");
		}
		if (reload) {
			assert.equal(reloadResourcesObserved, true, "reload resources_discover telemetry was not observed");
			assert.equal(reloadResponseObserved, true, "reload command response was not observed");
			assert.equal(reloadPromptSent, true, "post-reload prompt was not sent after reload response");
		}
		assert.equal(dialogIndex, plannedDialogs.length, "planned hosted questionnaire dialog sequence was not fully consumed");
		assert.equal(observedDialogMethods.length, plannedDialogs.length, "hosted questionnaire dialog count changed");
		return { events, cancellationResponses, childPid };
	} finally {
		if (!exit) {
			child.kill("SIGTERM");
			try { exit = await withTimeout(exited, 2_000, `Pi child ${childPid} SIGTERM cleanup`); }
			catch { child.kill("SIGKILL"); await withTimeout(exited, 2_000, `Pi child ${childPid} SIGKILL cleanup`); }
		}
	}
}

test("hosted real Pi RPC compares owned and public reference", async (t) => {
	const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	assert.equal(repoRoot, CHECKOUT_ROOT);
	const candidatePath = join(repoRoot, "extensions", "ask-user-question.ts");
	const fixturePath = join(repoRoot, "tests", "fixtures", "hosted-synthetic-provider.ts");
	assert.equal(candidatePath, OWNED_EXTENSION_PATH);
	assert.equal(fixturePath, FIXTURE_PATH);
	await access(candidatePath, constants.R_OK);
	await access(fixturePath, constants.R_OK);
	await access(REFERENCE_EXTENSION_PATH, constants.R_OK);
	await assert.rejects(access(repoRoot, constants.W_OK));
	const cliPath = resolvePiCli(repoRoot);
	const cases: HostedCase[] = [
		{ name: "owned", candidatePath, reference: false, scenario: "cancel" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "cancel" },
		{ name: "owned", candidatePath, reference: false, scenario: "single" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "single" },
		{ name: "owned", candidatePath, reference: false, scenario: "custom" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "custom" },
		{ name: "owned", candidatePath, reference: false, scenario: "multi" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "multi" },
		{ name: "owned", candidatePath, reference: false, scenario: "empty-multi" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "empty-multi" },
		{ name: "owned", candidatePath, reference: false, scenario: "partial-cancel" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "partial-cancel" },
		{ name: "owned", candidatePath, reference: false, scenario: "schema-positive" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "schema-positive" },
		{ name: "owned", candidatePath, reference: false, scenario: "invalid-missing-questions" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "invalid-missing-questions" },
		{ name: "owned", candidatePath, reference: false, scenario: "invalid-empty-questions" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "invalid-empty-questions" },
		{ name: "owned", candidatePath, reference: false, scenario: "invalid-one-option" },
		{ name: "reference", candidatePath: REFERENCE_EXTENSION_PATH, expectedSourcePath: REFERENCE_EXTENSION_PATH, reference: true, scenario: "invalid-one-option" },
	];
	const comparable = new Map<HostedScenario, ComparableResult[]>();
	const schemaComparisons: SchemaComparison[] = [];
	const invalidComparisons = new Map<InvalidScenario, InvalidComparison[]>();
	for (const testCase of cases) {
		await t.test(`hosted ${testCase.name} ${testCase.scenario}`, async (caseTest) => {
			assertHostedIsolation(testCase.reference === true);
			const sandbox = await mkdtemp(join(tmpdir(), `gentle-pi-hosted-rpc-${testCase.name}-${testCase.scenario}-`));
			caseTest.after(async () => { await rm(sandbox, { recursive: true, force: true }); });
			const result = await runRpc(cliPath, testCase.candidatePath, fixturePath, sandbox, testCase.expectedSourcePath, testCase.scenario);
			if (testCase.scenario === "schema-positive" || isInvalidScenario(testCase.scenario)) {
				const schema = schemaProjection(result.events);
				assertQuestionnaireSchema(schema, `${testCase.name} ${testCase.scenario}`, testCase.reference === false);
				if (testCase.scenario === "schema-positive") schemaComparisons.push({ name: testCase.name, schema });
			}
			if (isInvalidScenario(testCase.scenario)) {
				assert.equal(result.cancellationResponses, 0);
				const classification = assertInvalidRun(result.events, testCase.scenario);
				const pair = invalidComparisons.get(testCase.scenario) ?? [];
				pair.push({ name: testCase.name, classification }); invalidComparisons.set(testCase.scenario, pair);
				return;
			}
			const cancelled = testCase.scenario === "cancel" || testCase.scenario === "partial-cancel" || testCase.scenario === "schema-positive";
			assert.equal(result.cancellationResponses, cancelled ? 1 : 0);
			for (const marker of MARKERS) assert.equal(notificationCount(result.events, marker), marker === CANCELLED_MARKER ? (cancelled ? 1 : 0) : 1, marker);
			assert.equal(notificationCount(result.events, PUBLIC_TOOL_CALL_MARKER), 1);
			assert.equal(notificationCount(result.events, VALIDATION_ERROR_MARKER), 0);
			assert.equal(notificationCount(result.events, COMPLETED_MARKER), cancelled ? 0 : 1, `${COMPLETED_MARKER}; ${notificationMessages(result.events).filter((message) => message.startsWith("hosted:questionnaire-result-rejected:")).slice(0, 4).map((message) => message.slice(0, 800)).join("\n").slice(0, 2000)}`);
			const dialogs = result.events.filter((event) => event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(String(event.method)));
			const dialogMethods = dialogs.map((event) => String(event.method));
			if (testCase.scenario === "cancel" || testCase.scenario === "schema-positive") assert.deepEqual(dialogMethods, ["select"]);
			else if (testCase.scenario === "partial-cancel") assert.deepEqual(dialogMethods, testCase.name === "owned" ? ["select", "select", "select", "select"] : ["select", "select"]);
			else if (testCase.name === "owned" && testCase.scenario === "single") assert.deepEqual(dialogMethods, ["select", "select", "select"]);
			else if (testCase.name === "owned" && testCase.scenario === "custom") { assert.equal(dialogMethods[0], "select"); assert.ok(dialogMethods[1] === "editor" || dialogMethods[1] === "input"); assert.equal(dialogMethods[2], "select"); }
			else if (testCase.name === "owned" && testCase.scenario === "multi") assert.deepEqual(dialogMethods, ["select", "select", "select", "select", "select"]);
			else if (testCase.name === "owned") assert.deepEqual(dialogMethods, ["select"]);
			else if (testCase.scenario === "single") assert.deepEqual(dialogMethods, ["select"]);
			else if (testCase.scenario === "custom") assert.deepEqual(dialogMethods, ["select", "input"]);
			else if (testCase.scenario === "multi" || testCase.scenario === "empty-multi") assert.deepEqual(dialogMethods, ["input"]);
			else assert.fail(`unexpected dialog assertion for ${testCase.name} ${testCase.scenario}`);
			const selection = result.events.filter((event) => event.type === "extension_ui_request" && event.method === "select");
			const expectedSelectionCount = testCase.scenario === "cancel" || testCase.scenario === "schema-positive" ? 1
				: testCase.scenario === "partial-cancel" ? testCase.name === "owned" ? 4 : 2
					: testCase.name === "owned" ? testCase.scenario === "single" ? 3 : testCase.scenario === "custom" ? 2 : testCase.scenario === "multi" ? 5 : 1
						: testCase.scenario === "single" || testCase.scenario === "custom" ? 1 : 0;
			assert.equal(selection.length, expectedSelectionCount);
			if (testCase.scenario === "cancel" && testCase.name === "owned") {
				assert.match(String(selection[0]!.title), /Which layout should we inspect/);
				assert.deepEqual(selection[0]!.options, ["Choose an option", "Use custom text", "Skip", "Submit", "Submit partial", "Cancel"]);
			}
			const promptResponses = result.events.filter((event) => event.type === "response" && event.command === "prompt");
			assert.equal(promptResponses.length, 1);
			assert.equal(promptResponses[0]!.success, true);
			const toolEnds = result.events.filter((event) => event.type === "tool_execution_end" && event.toolName === TOOL_NAME);
			assert.equal(toolEnds.length, 1);
			const execution = record(toolEnds[0]!.result, "tool execution result");
			assert.equal(toolEnds[0]!.isError, false);
			const executionDetails = record(execution.details, "tool execution details");
			const messages = result.events.filter((event) => event.type === "message_end").map((event) => record(event.message, "message_end message"));
			const toolResult = messages.find((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
			assert.ok(toolResult);
			assert.equal(toolResult.isError, false);
			const toolResultDetails = record(toolResult.details, "tool result details");
			if (testCase.scenario === "cancel" || testCase.scenario === "schema-positive") {
				assert.equal(executionDetails.cancelled, true);
				assert.deepEqual(executionDetails.answers, []);
				assert.equal(toolResultDetails.cancelled, true);
				assert.deepEqual(toolResultDetails.answers, []);
			} else if (testCase.scenario === "partial-cancel") {
				assertPartialCancelledResult(execution.content, executionDetails);
				assertPartialCancelledResult(toolResult.content, toolResultDetails);
			} else {
				assertSuccessfulResult(execution.content, executionDetails, testCase.scenario);
				assertSuccessfulResult(toolResult.content, toolResultDetails, testCase.scenario);
			}
			const assistants = messages.filter((message) => message.role === "assistant");
			assert.ok(assistants.length >= 2);
			const finalAssistant = assistants[assistants.length - 1]!;
			assert.equal(finalAssistant.stopReason, "stop");
			const content = Array.isArray(finalAssistant.content) ? finalAssistant.content : [];
			assert.ok(content.some((block) => record(block, "assistant content").text === FINAL_TEXT[testCase.scenario]));
			assert.equal(result.events.filter((event) => event.type === "agent_settled").length, 1);
			const scenarioResults = comparable.get(testCase.scenario) ?? [];
			const projection = promptProjection(result.events);
			assert.deepEqual(projection, expectedPromptProjection(testCase.scenario), `${testCase.scenario} prompt projection must match its request`);
			scenarioResults.push({ result: { content: execution.content, details: { cancelled: executionDetails.cancelled, answers: executionDetails.answers } }, promptProjection: projection, blocked: blockedSequence(result.events) });
			comparable.set(testCase.scenario, scenarioResults);
		});
	}
	for (const scenario of ["cancel", "single", "custom", "multi", "empty-multi", "partial-cancel", "schema-positive"] as const) {
		const pair = comparable.get(scenario) ?? [];
		assert.equal(pair.length, 2, `${scenario} must have owned and reference results`);
		assert.deepEqual(pair[1]!.result, pair[0]!.result, scenario === "cancel" || scenario === "schema-positive" ? "public cancellation result parity" : `public ${scenario} result parity`);
		assert.deepEqual(pair[1]!.promptProjection, pair[0]!.promptProjection, `${scenario} JSON-safe prompt projection parity`);
		assert.deepEqual(pair[1]!.blocked, pair[0]!.blocked, `${scenario} blocked-event sequence parity`);
	}
	for (const scenario of ["invalid-missing-questions", "invalid-empty-questions", "invalid-one-option"] as const) {
		const pair = invalidComparisons.get(scenario) ?? [];
		assert.equal(pair.length, 2, `${scenario} must have owned and reference classifications`);
		assert.deepEqual(pair[1]!.classification, pair[0]!.classification, `${scenario} stable error classification parity`);
	}
	assert.equal(schemaComparisons.length, 2, "schema-positive must capture owned and reference schemas");
	const ownedSchema = schemaComparisons.find((comparison) => comparison.name === "owned");
	const referenceSchema = schemaComparisons.find((comparison) => comparison.name === "reference");
	assert.ok(ownedSchema); assert.ok(referenceSchema);
	assertSchemaCompatibility(ownedSchema!.schema, referenceSchema!.schema);
});

type HostedPackageTestContext = { after(callback: () => Promise<void>): unknown };
type HostedPackageCaseConfig = {
	packageCase: HostedPackageCase;
	candidatePath: string;
	expectedSourcePath?: string;
	observedSourcePath: string;
	reference: boolean;
};

async function runHostedPackageCase(t: HostedPackageTestContext, config: HostedPackageCaseConfig): Promise<void> {
	assertHostedIsolation(config.reference);
	const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	assert.equal(repoRoot, CHECKOUT_ROOT);
	const fixturePath = join(repoRoot, "tests", "fixtures", "hosted-synthetic-provider.ts");
	assert.equal(fixturePath, FIXTURE_PATH);
	await access(config.candidatePath, constants.R_OK);
	await access(fixturePath, constants.R_OK);
	if (config.reference) {
		await access(REFERENCE_EXTENSION_PATH, constants.R_OK);
		const referenceMetadata = JSON.parse(readFileSync(join(REFERENCE_PACKAGE_ROOT, "package.json"), "utf8")) as PiPackage;
		assert.equal(referenceMetadata.name, "@juicesharp/rpiv-ask-user-question");
		assert.equal(referenceMetadata.version, "2.9.0");
	}
	await assert.rejects(access(repoRoot, constants.W_OK));
	const cliPath = resolvePiCli(repoRoot);
	const sandbox = await mkdtemp(join(tmpdir(), `gentle-pi-hosted-rpc-package-${config.packageCase}-`));
	t.after(async () => { await rm(sandbox, { recursive: true, force: true }); });
	const result = await runRpc(cliPath, config.candidatePath, fixturePath, sandbox, config.expectedSourcePath, "cancel", false, config.packageCase);
	assert.equal(result.cancellationResponses, 1);
	assertHostedPackageComposition(result.events, config.packageCase, config.observedSourcePath);
	assertHostedPackageCancellation(result.events);
}

test("hosted package external-only loads the public reference with the private owner file present", async (t) => {
	await runHostedPackageCase(t, {
		packageCase: "external-only",
		candidatePath: REFERENCE_EXTENSION_PATH,
		expectedSourcePath: REFERENCE_EXTENSION_PATH,
		observedSourcePath: REFERENCE_EXTENSION_PATH,
		reference: true,
	});
});

test("hosted package candidate-only loads the workspace questionnaire", async (t) => {
	await runHostedPackageCase(t, {
		packageCase: "candidate-only",
		candidatePath: OWNED_EXTENSION_PATH,
		observedSourcePath: OWNED_EXTENSION_PATH,
		reference: false,
	});
});

async function runHostedNegativeOwnerCase(t: HostedPackageTestContext, ownerProfile: Exclude<HostedOwnerProfile, "gentle-pi">): Promise<void> {
	assertHostedIsolation(false);
	const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	assert.equal(repoRoot, CHECKOUT_ROOT);
	const fixturePath = join(repoRoot, "tests", "fixtures", "hosted-synthetic-provider.ts");
	assert.equal(fixturePath, FIXTURE_PATH);
	await access(OWNED_EXTENSION_PATH, constants.R_OK);
	await access(fixturePath, constants.R_OK);
	await assert.rejects(access(repoRoot, constants.W_OK));
	const cliPath = resolvePiCli(repoRoot);
	const sandbox = await mkdtemp(join(tmpdir(), `gentle-pi-hosted-rpc-owner-${ownerProfile}-`));
	t.after(async () => { await rm(sandbox, { recursive: true, force: true }); });
	const result = await runRpc(cliPath, OWNED_EXTENSION_PATH, fixturePath, sandbox, undefined, "cancel", false, "candidate-only", ownerProfile, "inventory-negative");
	assert.equal(result.cancellationResponses, 0);
	assertHostedNegativeProbe(result.events, ownerProfile);
}

test("hosted package candidate-only denies the questionnaire when the owner file is missing", async (t) => {
	await runHostedNegativeOwnerCase(t, "missing");
});

test("hosted package candidate-only denies the questionnaire for the legacy owner", async (t) => {
	await runHostedNegativeOwnerCase(t, "legacy-external");
});

test("hosted package filters the external questionnaire when the candidate is present", async (t) => {
	await runHostedPackageCase(t, {
		packageCase: "candidate-external-filtered",
		candidatePath: OWNED_EXTENSION_PATH,
		observedSourcePath: OWNED_EXTENSION_PATH,
		reference: true,
	});
});

test("hosted real Pi RPC reloads the owned questionnaire in place", async (t) => {
	assertHostedIsolation(false);
	const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
	const candidatePath = join(repoRoot, "extensions", "ask-user-question.ts");
	const fixturePath = join(repoRoot, "tests", "fixtures", "hosted-synthetic-provider.ts");
	assert.equal(candidatePath, OWNED_EXTENSION_PATH);
	assert.equal(fixturePath, FIXTURE_PATH);
	await access(candidatePath, constants.R_OK);
	await access(fixturePath, constants.R_OK);
	await assert.rejects(access(repoRoot, constants.W_OK));
	const cliPath = resolvePiCli(repoRoot);
	const sandbox = await mkdtemp(join(tmpdir(), "gentle-pi-hosted-rpc-reload-"));
	t.after(async () => { await rm(sandbox, { recursive: true, force: true }); });
	const result = await runRpc(cliPath, candidatePath, fixturePath, sandbox, undefined, "cancel", true);
	const events = result.events;
	assert.equal(result.cancellationResponses, 2);
	assert.equal(notificationCount(events, MARKERS[0]!), 2);
	assert.equal(notificationCount(events, MARKERS[1]!), 2);
	assert.equal(notificationCount(events, MARKERS[2]!), 2);
	assert.equal(notificationCount(events, MARKERS[3]!), 2);
	assert.equal(notificationCount(events, CANCELLED_MARKER), 2);
	assert.equal(notificationCount(events, PUBLIC_TOOL_CALL_MARKER), 2);
	assert.equal(notificationCount(events, VALIDATION_ERROR_MARKER), 0);
	assert.equal(notificationCount(events, COMPLETED_MARKER), 0);
	assert.equal(notificationCount(events, MARKERS[5]!), 2);
	assert.equal(notificationCount(events, MARKERS[6]!), 2);
	assert.equal(notificationCount(events, MARKERS[7]!), 2);
	const dialogs = events.filter((event) => event.type === "extension_ui_request" && ["select", "input", "editor", "confirm"].includes(String(event.method)));
	assert.deepEqual(dialogs.map((event) => event.method), ["select", "select"]);
	const promptResponses = events.filter((event) => event.type === "response" && event.command === "prompt");
	assert.deepEqual(promptResponses.map((event) => [event.id, event.success]), [["hosted-prompt-1", true], ["reload-1", true], ["hosted-prompt-2", true]]);
	const telemetry = reloadTelemetry(events);
	assert.ok(telemetry.every((entry) => entry.pid === result.childPid), "telemetry must identify the tracked child PID");
	assert.equal(new Set(telemetry.map((entry) => entry.pid)).size, 1, "reload generations must share one child PID");
	const of = (event: string, generation?: number): RpcRecord[] => telemetry.filter((entry) => entry.event === event && (generation === undefined || entry.generation === generation));
	assert.deepEqual(telemetry.filter((entry) => ["session_start", "resources_discover", "session_shutdown"].includes(String(entry.event))).map((entry) => [entry.generation, entry.event, entry.reason]), [
		[1, "session_start", "startup"], [1, "resources_discover", "startup"], [1, "session_shutdown", "reload"],
		[2, "session_start", "reload"], [2, "resources_discover", "reload"], [2, "session_shutdown", "quit"],
	]);
	assert.equal(of("session_start").length, 2);
	assert.equal(of("resources_discover").length, 2);
	assert.equal(of("session_shutdown").length, 2);
	assert.equal(of("session_shutdown", 1)[0]!.reason, "reload");
	assert.equal(of("session_shutdown", 2)[0]!.reason, "quit");
	const inventories = of("tool_inventory");
	assert.equal(inventories.length, 2);
	for (const inventory of inventories) {
		assert.equal(inventory.sourceInfo, OWNED_EXTENSION_PATH);
		assert.equal(inventory.count, 1);
		assert.equal(inventory.mode, "rpc");
		assert.equal(inventory.hasUI, true);
	}
	assert.equal(of("prompt").length, 2);
	assert.equal(of("blocked").length, 4);
	assert.equal(of("tool_callback").length, 6);
	assert.equal(of("provider_request").length, 4);
	assert.equal(of("provider_completion").length, 4);
	for (const generation of [1, 2]) {
		const toolCallId = `hosted-questionnaire-call-${generation}`;
		assert.equal(of("prompt", generation).length, 1);
		assert.deepEqual(of("blocked", generation).map((entry) => entry.active), [true, false]);
		assert.deepEqual(of("provider_request", generation).map((entry) => entry.toolCallId), [toolCallId, toolCallId]);
		assert.deepEqual(of("provider_completion", generation).map((entry) => entry.stopReason), ["toolUse", "stop"]);
		assert.equal(of("tool_callback", generation).length, 3);
		assertReloadToolResult(events, generation);
	}
	const reloadShutdownIndex = telemetryIndexes(events, (entry) => entry.generation === 1 && entry.event === "session_shutdown" && entry.reason === "reload")[0]!;
	const generationTwoStartIndex = telemetryIndexes(events, (entry) => entry.generation === 2 && entry.event === "session_start" && entry.reason === "reload")[0]!;
	const generationTwoResourcesIndex = telemetryIndexes(events, (entry) => entry.generation === 2 && entry.event === "resources_discover" && entry.reason === "reload")[0]!;
	const reloadResponseIndex = events.findIndex((event) => event.type === "response" && event.id === "reload-1");
	const secondPromptResponseIndex = events.findIndex((event) => event.type === "response" && event.id === "hosted-prompt-2");
	assert.ok(reloadShutdownIndex < generationTwoStartIndex);
	assert.ok(generationTwoStartIndex < generationTwoResourcesIndex);
	assert.ok(generationTwoResourcesIndex < reloadResponseIndex);
	assert.ok(reloadResponseIndex < secondPromptResponseIndex);
	for (let index = reloadShutdownIndex + 1; index < events.length; index += 1) {
		const entry = reloadTelemetryEvent(events[index]!);
		if (entry !== undefined) assert.notEqual(entry.generation, 1, "stale generation telemetry appeared after reload");
	}
	for (const generation of [1, 2]) {
		const blockedFalseIndex = telemetryIndexes(events, (entry) => entry.generation === generation && entry.event === "blocked" && entry.active === false)[0]!;
		const executionEndIndex = telemetryIndexes(events, (entry) => entry.generation === generation && entry.event === "tool_callback" && entry.phase === "execution_end")[0]!;
		const settledIndexes = events.flatMap((event, index) => event.type === "agent_settled" ? [index] : []);
		assert.ok(blockedFalseIndex < executionEndIndex);
		assert.ok(blockedFalseIndex < settledIndexes[generation - 1]!);
	}
	const questionnaireResults = events.filter((event) => event.type === "message_end").map((event) => record(event.message, "reload result message"))
		.filter((message) => message.role === "toolResult" && message.toolName === TOOL_NAME);
	assert.deepEqual(questionnaireResults.map((message) => message.toolCallId), ["hosted-questionnaire-call-1", "hosted-questionnaire-call-2"]);
	const finalAssistants = events.filter((event) => event.type === "message_end").map((event) => record(event.message, "reload assistant message"))
		.filter((message) => message.role === "assistant" && message.stopReason === "stop" && Array.isArray(message.content) && message.content.some((block) => record(block, "reload final content").text === FINAL_TEXT.cancel));
	assert.equal(finalAssistants.length, 2);
	assert.equal(events.filter((event) => event.type === "agent_settled").length, 2);
});
