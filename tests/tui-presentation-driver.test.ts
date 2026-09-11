import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import type { Component, KeybindingsManager, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import type { QuestionnaireExternalEditor } from "../lib/questions/external-editor.ts";
import { createTuiQuestionPresentationDriver } from "../lib/questions/tui-presentation-driver.ts";
import { validateAndFormat } from "../lib/questions/response.ts";
import { QuestionnaireTuiPresentation } from "../lib/questions/tui-presentation-view.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

type CustomComponent = Component & { dispose?(): void };
type CustomFactory<T> = (
	tui: TUI,
	theme: Theme,
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => CustomComponent | Promise<CustomComponent>;

type CustomOptions = {
	overlay?: boolean;
	overlayOptions?: OverlayOptions | (() => OverlayOptions);
	onHandle?: (handle: OverlayHandle) => void;
};

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

function request() {
	const result = createFrozenQuestionnaireRequest("tui-driver-correlation", { questions: [{
		question: "Choose a route", header: "Route", options: [
			{ label: "Direct", description: "Fast" }, { label: "Staged", description: "Careful" },
		],
	}, {
		question: "Choose checks", header: "Checks", multiSelect: true, options: [
			{ label: "Unit", description: "Fast" }, { label: "Integration", description: "Broad" },
		],
	}] });
	assert.equal(result.ok, true);
	if (!result.ok) throw new Error("fixture must be valid");
	return result.request;
}

function owned(outcome: unknown) {
	const formatted = validateAndFormat(request(), outcome);
	assert.equal(formatted.ok, true, "the owner validates the driver's raw outcome");
	return outcome;
}

class FakeCustomHost implements Pick<ExtensionUIContext, "custom"> {
	readonly lifecycle: string[] = [];
	readonly tui = {
		terminal: { rows: 24 },
		requestRender: (force?: boolean) => { this.lifecycle.push(`render:${force === true}`); },
		stop: (options?: { preserveScreen?: boolean }) => { this.lifecycle.push(`stop:${options?.preserveScreen === true}`); },
		start: () => { this.lifecycle.push("start"); },
	} as TUI;
	readonly keybindings = {} as KeybindingsManager;
	readonly received: Array<{ tui: TUI; theme: Theme; keybindings: KeybindingsManager }> = [];
	readonly receivedOptions: Array<CustomOptions | undefined> = [];
	calls = 0;
	doneCalls = 0;
	disposedAtDone = false;
	rawOutcome: unknown;
	component: QuestionnaireTuiPresentation | undefined;
	private readonly run: (component: QuestionnaireTuiPresentation) => void;
	private readonly hostError: Error | undefined;
	private readonly factoryTheme: Theme;
	constructor(run: (component: QuestionnaireTuiPresentation) => void, hostError?: Error, factoryTheme: Theme = theme) {
		this.run = run;
		this.hostError = hostError;
		this.factoryTheme = factoryTheme;
	}

	async custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
		this.calls++;
		this.receivedOptions.push(options);
		let resolve!: (result: T) => void;
		const result = new Promise<T>((done) => { resolve = done; });
		const component = await factory(this.tui, this.factoryTheme, this.keybindings, (outcome) => {
			this.doneCalls++;
			this.rawOutcome = outcome;
			this.disposedAtDone = this.component?.render(48).length === 0;
			resolve(outcome);
		});
		this.received.push({ tui: this.tui, theme: this.factoryTheme, keybindings: this.keybindings });
		this.component = component as QuestionnaireTuiPresentation;
		if (this.hostError) throw this.hostError;
		this.run(this.component);
		return result;
	}
}

type FutureTuiDriverFactory = (
	ui: Pick<ExtensionUIContext, "custom"> & Partial<Pick<ExtensionUIContext, "notify">>,
	localize?: Parameters<typeof createTuiQuestionPresentationDriver>[1],
	externalEditor?: QuestionnaireExternalEditor,
) => ReturnType<typeof createTuiQuestionPresentationDriver>;

async function settleExternalEditor(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

function assertSubsequence(actual: readonly string[], expected: readonly string[]): void {
	let offset = 0;
	for (const entry of expected) {
		offset = actual.indexOf(entry, offset);
		assert.ok(offset >= 0, `trace includes ${entry} after ${actual.join(", ")}`);
		offset++;
	}
}

async function captureDriverExternalEditor(host: FakeCustomHost, editor: QuestionnaireExternalEditor) {
	const presenting = createTuiQuestionPresentationDriver(host, undefined, editor).present(request());
	await settleExternalEditor();
	const externalEditor = (host.component as unknown as { presentationOptions?: { externalEditor?: QuestionnaireExternalEditor } } | undefined)
		?.presentationOptions?.externalEditor;
	if (!externalEditor) throw new Error("driver-created view exposes an injected external editor");
	return {
		externalEditor,
		cleanup: async () => {
			host.component?.cancel();
			await presenting;
		},
	};
}

async function expectUndefinedRejection(operation: () => Promise<unknown>): Promise<void> {
	let rejected = false;
	try {
		await operation();
	} catch (error) {
		rejected = true;
		assert.equal(error, undefined);
	}
	assert.equal(rejected, true);
}

class SyncThrowAfterFactoryHost implements Pick<ExtensionUIContext, "custom"> {
	readonly tui = { terminal: { rows: 24 }, requestRender: () => {} } as TUI;
	readonly keybindings = {} as KeybindingsManager;
	readonly error = new Error("synchronous custom failure");
	calls = 0;
	doneCalls = 0;
	component: QuestionnaireTuiPresentation | undefined;

	custom<T>(factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		this.component = factory(this.tui, theme, this.keybindings, () => { this.doneCalls++; }) as QuestionnaireTuiPresentation;
		throw this.error;
	}
}

class RejectBeforeLateFactoryHost implements Pick<ExtensionUIContext, "custom"> {
	readonly tui = { terminal: { rows: 24 }, requestRender: () => {} } as TUI;
	readonly keybindings = {} as KeybindingsManager;
	readonly error = new Error("custom rejected before factory");
	calls = 0;
	doneCalls = 0;
	private factory: CustomFactory<unknown> | undefined;

	custom<T>(factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		this.factory = factory as unknown as CustomFactory<unknown>;
		return Promise.reject(this.error) as Promise<T>;
	}

	invokeLateFactory(): CustomComponent {
		assert.ok(this.factory, "host retained the public factory");
		const component = this.factory(this.tui, theme, this.keybindings, () => { this.doneCalls++; });
		assert.equal(component instanceof Promise, false, "adapter factory is synchronous");
		return component as CustomComponent;
	}
}

test("invokes custom once with host arguments and returns a reducer-owned partial outcome", async () => {
	const host = new FakeCustomHost((component) => {
		component.handleInput("\r");
		component.handleInput("n");
		component.handleInput("s");
	});
	const outcome = owned(await createTuiQuestionPresentationDriver(host).present(request()));
	assert.equal(host.calls, 1);
	assert.equal(outcome, host.rawOutcome, "the adapter preserves raw outcome identity");
	assert.deepEqual(host.received, [{ tui: host.tui, theme, keybindings: host.keybindings }]);
	assert.deepEqual(outcome, {
		correlationId: "tui-driver-correlation", cancelled: false,
		answers: [{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Direct" }],
	});
});

test("future external editing stops the TUI before invocation and restores a forced render after success", async () => {
	const calls: string[] = [];
	const host = new FakeCustomHost((component) => {
		component.handleInput("\t");
		component.handleInput("driver draft");
		component.handleInput("\u0007");
	});
	const driver = (createTuiQuestionPresentationDriver as unknown as FutureTuiDriverFactory)(host, undefined, async (draft) => {
		host.lifecycle.push(`editor:${draft}`);
		calls.push(draft);
		return "driver result";
	});
	const presenting = driver.present(request());
	try {
		await settleExternalEditor();
		assert.deepEqual(calls, ["driver draft"]);
		assertSubsequence(host.lifecycle, ["stop:true", "editor:driver draft", "start", "render:true"]);
	} finally {
		host.component?.cancel();
		await presenting;
	}
});

test("future external editing restores the TUI and reports localized rejection through the public driver UI", async () => {
	const calls: string[] = [];
	const notices: string[] = [];
	const host = new FakeCustomHost((component) => {
		component.handleInput("\t");
		component.handleInput("failure draft");
		component.handleInput("\u0007");
	});
	const ui = Object.assign(host, { notify(message: string, level?: string) { notices.push(`${level}:${message}`); } }) as Pick<ExtensionUIContext, "custom"> & Partial<Pick<ExtensionUIContext, "notify">>;
	const driver = (createTuiQuestionPresentationDriver as unknown as FutureTuiDriverFactory)(ui,
		(key, fallback) => key === "editor.failed" ? "Editor fehlgeschlagen" : fallback,
		async (draft) => {
			host.lifecycle.push(`editor:${draft}`);
			calls.push(draft);
			throw new Error("editor rejected");
		});
	const presenting = driver.present(request());
	try {
		await settleExternalEditor();
		assert.deepEqual(calls, ["failure draft"]);
		assertSubsequence(host.lifecycle, ["stop:true", "editor:failure draft", "start", "render:true"]);
		assert.deepEqual(notices, ["error:Editor fehlgeschlagen"]);
	} finally {
		host.component?.cancel();
		await presenting;
	}
});

test("an undefined start failure preserves the external draft and reports the view error", async () => {
	const notices: string[] = [];
	const host = new FakeCustomHost((component) => {
		component.handleInput("\t");
		component.handleInput("original draft");
		component.handleInput("\u0007");
	});
	host.tui.start = () => { host.lifecycle.push("start"); throw undefined; };
	const ui = Object.assign(host, { notify(message: string, level?: string) { notices.push(`${level}:${message}`); } }) as Pick<ExtensionUIContext, "custom"> & Partial<Pick<ExtensionUIContext, "notify">>;
	const presenting = createTuiQuestionPresentationDriver(ui, undefined, async () => "edited value").present(request());
	try {
		await settleExternalEditor();
		assert.match(host.component!.render(48).join("\n"), /original draft/);
		assert.deepEqual(notices, ["error:External editor failed"]);
		assertSubsequence(host.lifecycle, ["stop:true", "start", "render:true"]);
	} finally {
		host.component?.cancel();
		await presenting;
	}
});

for (const scenario of [
	{ name: "an undefined editor failure before a start error", calls: 1, configure(host: FakeCustomHost) { host.tui.start = () => { host.lifecycle.push("start"); throw new Error("start"); }; }, editor: async () => { throw undefined; } },
	{ name: "an undefined stop failure before a start error", calls: 0, configure(host: FakeCustomHost) { host.tui.stop = () => { host.lifecycle.push("stop:true"); throw undefined; }; host.tui.start = () => { host.lifecycle.push("start"); throw new Error("start"); }; }, editor: async () => "unused" },
	{ name: "an undefined forced render failure after editor success", calls: 1, configure(host: FakeCustomHost) { host.tui.requestRender = (force?: boolean) => { host.lifecycle.push(`render:${force === true}`); throw undefined; }; }, editor: async () => "edited" },
	{ name: "an undefined start failure before a render error", calls: 1, configure(host: FakeCustomHost) { host.tui.start = () => { host.lifecycle.push("start"); throw undefined; }; host.tui.requestRender = (force?: boolean) => { host.lifecycle.push(`render:${force === true}`); throw new Error("render"); }; }, editor: async () => "edited" },
]) {
	test(`driver wrapper preserves ${scenario.name}`, async () => {
		const host = new FakeCustomHost(() => {});
		let calls = 0;
		scenario.configure(host);
		const { externalEditor, cleanup } = await captureDriverExternalEditor(host, async (draft) => {
			calls++;
			return scenario.editor(draft);
		});
		try {
			await expectUndefinedRejection(() => externalEditor("draft"));
			assert.equal(calls, scenario.calls);
			assert.ok(host.lifecycle.includes("render:true"));
		} finally {
			await cleanup();
		}
	});
}

test("requests a full-width terminal-capped public overlay for the questionnaire", async () => {
	const host = new FakeCustomHost((component) => component.handleInput("\u001b"));
	await createTuiQuestionPresentationDriver(host).present(request());
	assert.deepEqual(host.receivedOptions, [{
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 },
	}], "the host receives the unchanged public full-width terminal-capped overlay contract");
});

test("returns the view's raw cancel outcome without driver formatting", async () => {
	const host = new FakeCustomHost((component) => component.handleInput("\u001b"));
	const outcome = owned(await createTuiQuestionPresentationDriver(host).present(request()));
	assert.deepEqual(outcome, { correlationId: "tui-driver-correlation", cancelled: true, answers: [] });
});

test("disposes before completion and ignores late input without a second done callback", async () => {
	const host = new FakeCustomHost((component) => component.handleInput("\u001b"));
	const outcome = await createTuiQuestionPresentationDriver(host).present(request());
	assert.equal(host.doneCalls, 1);
	assert.equal(host.disposedAtDone, true, "the view is disposed before the host completion callback");
	assert.equal(host.component!.render(48).length, 0);
	host.component!.handleInput("s");
	assert.equal(host.doneCalls, 1);
	assert.deepEqual(owned(outcome), { correlationId: "tui-driver-correlation", cancelled: true, answers: [] });
});

test("propagates a host rejection, disposes the created view, and fabricates no cancellation", async () => {
	const hostError = new Error("host rejected custom UI");
	const host = new FakeCustomHost(() => {}, hostError);
	await assert.rejects(createTuiQuestionPresentationDriver(host).present(request()), hostError);
	assert.equal(host.component!.render(48).length, 0);
	host.component!.handleInput("\u001b");
	assert.equal(host.doneCalls, 0);
});

test("propagates a real view-factory failure without a local fallback", async () => {
	const host = new FakeCustomHost(() => {}, undefined, null as unknown as Theme);
	await assert.rejects(createTuiQuestionPresentationDriver(host).present(request()));
	assert.equal(host.calls, 1);
	assert.equal(host.component, undefined);
});

test("turns a synchronous custom throw after factory creation into a rejected promise and disposes it", async () => {
	const host = new SyncThrowAfterFactoryHost();
	let presenting: Promise<unknown> | undefined;
	assert.doesNotThrow(() => { presenting = createTuiQuestionPresentationDriver(host).present(request()) as Promise<unknown>; });
	await assert.rejects(presenting, host.error);
	assert.equal(host.calls, 1);
	assert.equal(host.component!.render(48).length, 0);
	host.component!.handleInput("\u001b");
	assert.equal(host.doneCalls, 0);
});

test("rejects before a late retained factory can create a live view or forward completion", async () => {
	const host = new RejectBeforeLateFactoryHost();
	await assert.rejects(createTuiQuestionPresentationDriver(host).present(request()), host.error);
	const component = host.invokeLateFactory();
	assert.deepEqual(component.render(48), []);
	component.handleInput?.("\u001b");
	assert.equal(host.calls, 1);
	assert.equal(host.doneCalls, 0);
});

class TrackingAbortSignal {
	aborted = false;
	addCalls = 0;
	removeCalls = 0;
	readonly listeners = new Set<() => void>();

	addEventListener(type: string, listener: () => void): void {
		if (type !== "abort") return;
		this.addCalls++;
		this.listeners.add(listener);
	}

	removeEventListener(type: string, listener: () => void): void {
		if (type !== "abort") return;
		this.removeCalls++;
		this.listeners.delete(listener);
	}

	abort(): void {
		if (this.aborted) return;
		this.aborted = true;
		for (const listener of this.listeners) listener();
	}
}

class PreAbortedNoUiHost implements Pick<ExtensionUIContext, "custom"> {
	calls = 0;

	custom<T>(_factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		throw new Error("pre-aborted presentation must not show host UI");
	}
}

class DeferredFactoryHost implements Pick<ExtensionUIContext, "custom"> {
	readonly tui = { terminal: { rows: 24 }, requestRender: () => {} } as TUI;
	readonly keybindings = {} as KeybindingsManager;
	calls = 0;
	doneCalls = 0;
	private factory: CustomFactory<unknown> | undefined;
	private settleResult: ((result: unknown) => void) | undefined;

	custom<T>(factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		this.factory = factory as unknown as CustomFactory<unknown>;
		return new Promise<T>((resolve) => { this.settleResult = resolve as (result: unknown) => void; });
	}

	invokeLateFactory(): CustomComponent {
		assert.ok(this.factory, "host retained the public factory");
		const component = this.factory(this.tui, theme, this.keybindings, () => { this.doneCalls++; });
		assert.equal(component instanceof Promise, false, "adapter factory is synchronous");
		return component as CustomComponent;
	}

	settle(): void {
		this.settleResult?.({ correlationId: "tui-driver-correlation", cancelled: true, answers: [] });
	}
}

test("pre-abort skips host UI and returns a valid cancelled questionnaire outcome", async () => {
	const signal = new TrackingAbortSignal();
	signal.abort();
	const host = new PreAbortedNoUiHost();
	const outcome = owned(await createTuiQuestionPresentationDriver(host).present(request(), signal));
	assert.equal(host.calls, 0);
	assert.deepEqual(outcome, { correlationId: "tui-driver-correlation", cancelled: true, answers: [] });
});

test("abort after factory disposes before done and preserves reducer-committed partial answers", async () => {
	const signal = new TrackingAbortSignal();
	let disposedImmediately = false;
	const host = new FakeCustomHost((component) => {
		component.handleInput("\r");
		component.handleInput("n");
		signal.abort();
		disposedImmediately = component.render(48).length === 0;
		if (!disposedImmediately) component.handleInput("\u001b");
	});
	const outcome = owned(await createTuiQuestionPresentationDriver(host).present(request(), signal));
	assert.equal(disposedImmediately, true, "abort finalizes the public view before host completion");
	assert.equal(host.doneCalls, 1);
	assert.equal(host.disposedAtDone, true);
	assert.deepEqual(outcome, {
		correlationId: "tui-driver-correlation", cancelled: true,
		answers: [{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Direct" }],
	});
});

test("abort before a late retained factory leaves its component terminal and inert", async () => {
	const signal = new TrackingAbortSignal();
	const host = new DeferredFactoryHost();
	const presenting = createTuiQuestionPresentationDriver(host).present(request(), signal);
	signal.abort();
	const component = host.invokeLateFactory();
	try {
		assert.deepEqual(component.render(48), []);
		component.handleInput?.("\u001b");
		assert.equal(host.doneCalls, 0);
	} finally {
		host.settle();
		await presenting;
	}
});

test("normal completion and host rejection detach abort listeners, and later abort is inert", async () => {
	const completedSignal = new TrackingAbortSignal();
	const completedHost = new FakeCustomHost((component) => component.handleInput("\u001b"));
	await createTuiQuestionPresentationDriver(completedHost).present(request(), completedSignal);
	assert.equal(completedSignal.addCalls, 1);
	assert.equal(completedSignal.listeners.size, 0);
	completedSignal.abort();
	assert.equal(completedHost.doneCalls, 1, "abort after normal completion is a no-op");

	const rejectedSignal = new TrackingAbortSignal();
	const rejectedHost = new SyncThrowAfterFactoryHost();
	await assert.rejects(createTuiQuestionPresentationDriver(rejectedHost).present(request(), rejectedSignal), rejectedHost.error);
	assert.equal(rejectedSignal.addCalls, 1);
	assert.equal(rejectedSignal.listeners.size, 0);
	assert.equal(rejectedSignal.removeCalls, 1);
});
