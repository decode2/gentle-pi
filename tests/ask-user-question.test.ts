import assert from "node:assert/strict";
import test from "node:test";
import { createAskUserQuestionExtension, type AskUserQuestionDependencies } from "../extensions/ask-user-question.ts";
import type { QuestionOwnerConfigResolution } from "../lib/questions/owner-config.ts";
import type { QuestionPresentationDriver } from "../lib/questions/contract.ts";

type SessionHandler = (event: unknown, ctx: { mode: string; ui: { custom: unknown } }) => Promise<void> | void;
type RegisteredTool = { name: string; parameters: { properties?: Record<string, unknown> }; execute: (...args: unknown[]) => Promise<unknown> };

function owner(ownerName: "gentle-pi" | "legacy-external" | "disabled"): QuestionOwnerConfigResolution {
	return ownerName === "gentle-pi"
		? { allowRegistration: true, owner: "gentle-pi", reason: "configured_gentle_pi", path: "/profiles/test/gentle-ai/question-owner.json" }
		: { allowRegistration: false, owner: ownerName, reason: ownerName === "disabled" ? "configured_disabled" : "configured_external", path: "/profiles/test/gentle-ai/question-owner.json" };
}

function host(inventory: string[] = []) {
	const sessionStarts: SessionHandler[] = [];
	const tools: RegisteredTool[] = [];
	const events: Array<{ channel: string; active: boolean }> = [];
	let inventoryCalls = 0;
	const pi = {
		on(event: string, handler: SessionHandler) { if (event === "session_start") sessionStarts.push(handler); },
		registerTool(tool: RegisteredTool) { tools.push(tool); },
		getAllTools() { inventoryCalls++; return inventory.map((name) => ({ name })); },
		events: { emit(channel: string, data: { active: boolean }) { events.push({ channel, active: data.active }); } },
	};
	return { pi, sessionStarts, tools, events, inventoryCalls: () => inventoryCalls };
}

function dependencies(config: QuestionOwnerConfigResolution, driver?: QuestionPresentationDriver): AskUserQuestionDependencies {
	return {
		resolveAgentHome: () => "/profiles/test",
		readOwnerConfig: async () => config,
		createPresentationDriver: () => driver ?? { present: async () => { throw new Error("test driver was not supplied"); } },
	};
}

async function start(subject: ReturnType<typeof host>, mode: string, custom: unknown = async () => undefined): Promise<void> {
	assert.equal(subject.sessionStarts.length, 1, "the factory registers one session_start handler");
	await subject.sessionStarts[0]!({ type: "session_start", reason: "startup" }, { mode, ui: { custom } });
}

test("does not register the questionnaire for legacy or disabled owners", async () => {
	for (const configuredOwner of ["legacy-external", "disabled"] as const) {
		const subject = host();
		createAskUserQuestionExtension(dependencies(owner(configuredOwner)))(subject.pi as never);
		assert.deepEqual(subject.tools, [], "factory registration is deferred until a session has a mode");
		await start(subject, "tui");
		assert.deepEqual(subject.tools, []);
	}
});

test("registers the exact bounded questionnaire schema only in a TUI session", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "tui");
	assert.equal(subject.tools.length, 1);
	const tool = subject.tools[0]!;
	assert.equal(tool.name, "ask_user_question");
	assert.deepEqual(Object.keys(tool.parameters.properties ?? {}).sort(), ["questions"]);
	const questions = tool.parameters.properties?.questions as { minItems?: number; maxItems?: number; items?: { properties?: Record<string, { maxLength?: number }> } };
	assert.equal(questions.minItems, 1);
	assert.equal(questions.maxItems, 4);
	assert.equal(questions.items?.properties?.header?.maxLength, 16);
	assert.equal(questions.items?.properties?.options?.maxItems, 4);
	assert.equal(questions.items?.properties?.options?.minItems, 2);
	assert.equal((questions.items?.properties?.options as { items?: { properties?: Record<string, { maxLength?: number }> } }).items?.properties?.label?.maxLength, 60);
});

test("never registers for print, json, or RPC sessions", async () => {
	for (const mode of ["print", "json", "rpc"]) {
		const subject = host();
		createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
		await start(subject, mode);
		assert.deepEqual(subject.tools, [], mode);
	}
});

test("does not displace an incumbent public tool name", async () => {
	const subject = host(["ask_user_question"]);
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "tui");
	assert.equal(subject.inventoryCalls(), 1, "inventory is consulted after the host binds the session");
	assert.deepEqual(subject.tools, []);
});

test("makes repeated TUI session starts idempotent", async () => {
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi")))(subject.pi as never);
	await start(subject, "tui");
	await start(subject, "tui");
	assert.deepEqual(subject.tools.map((tool) => tool.name), ["ask_user_question"]);
});

test("correlates and aborts one TUI request, balances status, and rejects concurrent execution", async () => {
	let captured: { correlationId: string; signal: AbortSignal | undefined } | undefined;
	let finish: (() => void) | undefined;
	const driver: QuestionPresentationDriver = { present: (request, signal) => new Promise((resolve) => {
		captured = { correlationId: request.correlationId, signal };
		finish = () => resolve({ correlationId: request.correlationId, cancelled: true, answers: [] });
	}) };
	const subject = host();
	createAskUserQuestionExtension(dependencies(owner("gentle-pi"), driver))(subject.pi as never);
	await start(subject, "tui");
	const tool = subject.tools[0]!;
	const signal = new AbortController().signal;
	const context = { mode: "tui", ui: { custom: async () => undefined } };
	const first = tool.execute("call-42", { questions: [{ question: "Proceed?", header: "Proceed", options: [{ label: "Yes", description: "Continue" }, { label: "No", description: "Stop" }] }] }, signal, undefined, context);
	await assert.rejects(() => tool.execute("call-43", { questions: [] }, signal, undefined, context), /already active/i);
	assert.deepEqual(captured, { correlationId: "call-42", signal });
	finish?.();
	await first;
	assert.deepEqual(subject.events, [
		{ channel: "rpiv:ask-user:blocked", active: true },
		{ channel: "rpiv:ask-user:blocked", active: false },
	]);
});
