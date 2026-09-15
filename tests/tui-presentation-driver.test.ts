import assert from "node:assert/strict";
import test from "node:test";
import { Theme, type ExtensionUIContext, type TerminalInputHandler } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, TuiAltScreen, visibleWidth, type KeybindingsConfig } from "@earendil-works/pi-tui";
import type {
	Component,
	OverlayHandle,
	OverlayUnfocusOptions,
	Terminal,
	TUI,
	TuiStopOptions,
} from "@earendil-works/pi-tui";
import type { QuestionnaireExternalEditor } from "../lib/questions/external-editor.ts";
import { createTuiQuestionPresentationDriver } from "../lib/questions/tui-presentation-driver.ts";
import { validateAndFormat } from "../lib/questions/response.ts";
import { QuestionnaireTuiPresentation } from "../lib/questions/tui-presentation-view.ts";
import { createFrozenQuestionnaireRequest } from "../lib/questions/validation.ts";

type CustomComponent = Component & { dispose?(): void };
type ExtensionCustomFactory = Parameters<ExtensionUIContext["custom"]>[0];
type CustomFactory<T> = (
	tui: Parameters<ExtensionCustomFactory>[0],
	theme: Parameters<ExtensionCustomFactory>[1],
	keybindings: KeybindingsManager,
	done: (result: T) => void,
) => CustomComponent | Promise<CustomComponent>;

type CustomOptions = NonNullable<Parameters<ExtensionUIContext["custom"]>[1]>;
type CustomHost = {
	custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T>;
};

const testForegroundColors = {
	accent: "",
	border: "",
	borderAccent: "",
	borderMuted: "",
	success: "",
	error: "",
	warning: "",
	muted: "",
	dim: "",
	text: "",
	thinkingText: "",
	userMessageText: "",
	customMessageText: "",
	customMessageLabel: "",
	toolTitle: "",
	toolOutput: "",
	mdHeading: "",
	mdLink: "",
	mdLinkUrl: "",
	mdCode: "",
	mdCodeBlock: "",
	mdCodeBlockBorder: "",
	mdQuote: "",
	mdQuoteBorder: "",
	mdHr: "",
	mdListBullet: "",
	toolDiffAdded: "",
	toolDiffRemoved: "",
	toolDiffContext: "",
	syntaxComment: "",
	syntaxKeyword: "",
	syntaxFunction: "",
	syntaxVariable: "",
	syntaxString: "",
	syntaxNumber: "",
	syntaxType: "",
	syntaxOperator: "",
	syntaxPunctuation: "",
	thinkingOff: "",
	thinkingMinimal: "",
	thinkingLow: "",
	thinkingMedium: "",
	thinkingHigh: "",
	thinkingXhigh: "",
	bashMode: "",
};

const testBackgroundColors = {
	selectedBg: "",
	userMessageBg: "",
	customMessageBg: "",
	toolPendingBg: "",
	toolSuccessBg: "",
	toolErrorBg: "",
};

const theme = new Theme(testForegroundColors, testBackgroundColors, "truecolor");
const testKeybindingDefinitions = {
	...TUI_KEYBINDINGS,
	"app.editor.external": { defaultKeys: "ctrl+g", description: "Open external editor" },
} satisfies ConstructorParameters<typeof KeybindingsManager>[0];
const testKeybindings = new KeybindingsManager(testKeybindingDefinitions);

function localKeybindings(userBindings: KeybindingsConfig = {}): KeybindingsManager {
	return new KeybindingsManager(testKeybindingDefinitions, userBindings);
}

const ESCAPE = "\u001b";
const CTRL_C = "\u0003";
const CTRL_Q = "\u0011";
const COLLAPSE = "\u001d";
const KITTY_CTRL_Q_REPEAT = "\u001b[113;5:2u";
const KITTY_CTRL_Q_RELEASE = "\u001b[113;5:3u";

class FailingTheme extends Theme {
	constructor() {
		super(testForegroundColors, testBackgroundColors, "truecolor");
	}

	override fg(_color: Parameters<Theme["fg"]>[0], _text: string): string {
		throw new Error("view theme failure");
	}
}

function questionnaireComponent(component: CustomComponent): QuestionnaireTuiPresentation {
	if (!(component instanceof QuestionnaireTuiPresentation)) throw new Error("expected questionnaire presentation component");
	return component;
}

function synchronousComponent(component: CustomComponent | Promise<CustomComponent>, message: string): CustomComponent {
	assert.equal(component instanceof Promise, false, message);
	if (component instanceof Promise) throw new Error(message);
	return component;
}

function isQuestionnaireExternalEditor(value: unknown): value is QuestionnaireExternalEditor {
	return typeof value === "function";
}

function injectedExternalEditor(view: QuestionnaireTuiPresentation): QuestionnaireExternalEditor | undefined {
	const options: unknown = Object.getOwnPropertyDescriptor(view, "presentationOptions")?.value;
	if (typeof options !== "object" || options === null || !("externalEditor" in options)) return undefined;
	const editor: unknown = options.externalEditor;
	return isQuestionnaireExternalEditor(editor) ? editor : undefined;
}

function asPromise<T>(value: T | Promise<T>): Promise<T> {
	return Promise.resolve(value);
}

type EventTargetAddArguments = Parameters<EventTarget["addEventListener"]>;
type EventTargetRemoveArguments = Parameters<EventTarget["removeEventListener"]>;

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

function isFocusedControlLine(line: string, label: string): boolean {
	if (line === `→ ${label}` || line === `→ [${label}]`) return true;
	for (const prefix of ["→ ( ) ", "→ (●) ", "→ [ ] ", "→ [x] "]) {
		const control = `${prefix}${label}`;
		const suffix = line.startsWith(control) ? line.slice(control.length) : undefined;
		if (suffix === "" || /^ *│/.test(suffix ?? "")) return true;
	}
	return false;
}

function focusCustomForKeyboard(component: QuestionnaireTuiPresentation, width = 48): void {
	const initial = component.render(width).map((line) => stripTerminalSequences(line).trim());
	const optionCount = Math.max(2, initial.filter((line) => /^(?:→ )?(?:\([● ]\)|\[[x ]\])\s/.test(line)).length);
	const maxSteps = optionCount + 3;
	for (let step = 0; step < maxSteps; step++) {
		const lines = component.render(width).map((line) => stripTerminalSequences(line).trim());
		if (lines.some((line) => isFocusedControlLine(line, "Custom answer"))) {
			component.handleInput("\r");
			return;
		}
		component.handleInput("\t");
	}
	assert.fail("bounded keyboard traversal could not focus Custom answer");
}

function owned(outcome: unknown) {
	const formatted = validateAndFormat(request(), outcome);
	assert.equal(formatted.ok, true, "the owner validates the driver's raw outcome");
	return outcome;
}

class FakeCustomHost implements CustomHost {
	readonly tui: TestTui;
	readonly keybindings: KeybindingsManager;
	readonly received: Array<{ tui: TUI; theme: Theme; keybindings: KeybindingsManager }> = [];
	readonly receivedOptions: Array<CustomOptions | undefined> = [];
	calls = 0;
	doneCalls = 0;
	disposedAtDone = false;
	rawOutcome: unknown;
	component: QuestionnaireTuiPresentation | undefined;
	notifyHandler: ((message: string, type?: "info" | "warning" | "error") => void) | undefined;
	private readonly run: (component: QuestionnaireTuiPresentation) => void;
	private readonly hostError: Error | undefined;
	private readonly factoryTheme: Theme;
	constructor(run: (component: QuestionnaireTuiPresentation) => void, hostError?: Error, factoryTheme: Theme = theme,
		keybindings: KeybindingsManager = testKeybindings) {
		this.tui = new TestTui();
		this.keybindings = keybindings;
		this.run = run;
		this.hostError = hostError;
		this.factoryTheme = factoryTheme;
	}

	get lifecycle(): string[] { return this.tui.lifecycle; }

	notify(message: string, type?: "info" | "warning" | "error"): void {
		this.notifyHandler?.(message, type);
	}

	async custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
		this.calls++;
		this.receivedOptions.push(options);
		let resolve: ((result: T | PromiseLike<T>) => void) | undefined;
		const result = new Promise<T>((done) => { resolve = done; });
		const component = await factory(this.tui, this.factoryTheme, this.keybindings, (outcome) => {
			this.doneCalls++;
			this.rawOutcome = outcome;
			this.disposedAtDone = this.component?.render(48).length === 0;
			resolve?.(outcome);
		});
		this.received.push({ tui: this.tui, theme: this.factoryTheme, keybindings: this.keybindings });
		this.component = questionnaireComponent(component);
		if (this.hostError) throw this.hostError;
		this.run(this.component);
		return result;
	}
}

class TestTerminal implements Terminal {
	columns = 80;
	rows = 32;
	private inputHandler: ((data: string) => void) | undefined;
	private resizeHandler: (() => void) | undefined;

	get kittyProtocolActive(): boolean { return false; }

	start(onInput: (data: string) => void, onResize: () => void): void {
		this.inputHandler = onInput;
		this.resizeHandler = onResize;
	}

	stop(): void {
		this.inputHandler = undefined;
		this.resizeHandler = undefined;
	}

	drainInput(): Promise<void> { return Promise.resolve(); }
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}

	feed(data: string): void {
		const inputHandler = this.inputHandler;
		assert.ok(inputHandler, "the public TUI started its terminal input route");
		inputHandler(data);
	}

	resize(rows: number): void {
		this.rows = rows;
		this.resizeHandler?.();
	}
}

class TestTui extends TuiAltScreen {
	readonly lifecycle: string[] = [];
	startOverride: (() => void) | undefined;
	stopOverride: (() => void) | undefined;
	requestRenderOverride: (() => void) | undefined;

	constructor() {
		const terminal = new TestTerminal();
		terminal.rows = 24;
		super(terminal);
	}

	override start(): void {
		this.lifecycle.push("start");
		this.startOverride?.();
	}

	override stop(options?: TuiStopOptions): void {
		this.lifecycle.push(`stop:${options?.preserveScreen === true}`);
		this.stopOverride?.();
	}

	override requestRender(force?: boolean): void {
		this.lifecycle.push(`render:${force === true}`);
		this.requestRenderOverride?.();
	}
}

class PublicTuiHost implements CustomHost {
	readonly terminal = new TestTerminal();
	readonly tui = new TuiAltScreen(this.terminal);
	readonly keybindings = testKeybindings;
	component: QuestionnaireTuiPresentation | undefined;
	handle: OverlayHandle | undefined;
	doneCalls = 0;
	rawOutcome: unknown;

	async custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
		let resolve: ((result: T | PromiseLike<T>) => void) | undefined;
		const result = new Promise<T>((done) => { resolve = done; });
		const component = await factory(this.tui, theme, this.keybindings, (outcome) => {
			this.doneCalls++;
			this.rawOutcome = outcome;
			this.handle?.hide();
			resolve?.(outcome);
		});
		this.component = questionnaireComponent(component);
		assert.equal(options?.overlay, true, "the public host test receives an overlay presentation");
		const overlayOptions = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
		const handle = this.tui.showOverlay(component, overlayOptions);
		this.handle = handle;
		options?.onHandle?.(handle);
		return result;
	}
}

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

function feedSgrClick(terminal: TestTerminal, x: number, y: number): void {
	const press = `\u001b[<0;${x + 1};${y + 1}M`;
	const release = `\u001b[<0;${x + 1};${y + 1}m`;
	terminal.feed(press);
	terminal.feed(release);
}

async function captureDriverExternalEditor(host: FakeCustomHost, editor: QuestionnaireExternalEditor) {
	const presenting = asPromise(createTuiQuestionPresentationDriver(host, undefined, editor).present(request()));
	await settleExternalEditor();
	const view = host.component;
	if (!view) throw new Error("driver-created view is unavailable");
	const externalEditor = injectedExternalEditor(view);
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

class SyncThrowAfterFactoryHost implements CustomHost {
	readonly tui = new TestTui();
	readonly keybindings = testKeybindings;
	readonly error = new Error("synchronous custom failure");
	calls = 0;
	doneCalls = 0;
	component: QuestionnaireTuiPresentation | undefined;

	custom<T>(factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		const component = synchronousComponent(factory(this.tui, theme, this.keybindings, () => { this.doneCalls++; }), "adapter factory is synchronous");
		this.component = questionnaireComponent(component);
		throw this.error;
	}
}

class RejectBeforeLateFactoryHost implements CustomHost {
	readonly tui = new TestTui();
	readonly keybindings = testKeybindings;
	readonly error = new Error("custom rejected before factory");
	calls = 0;
	doneCalls = 0;
	private invokeFactory: (() => CustomComponent) | undefined;

	custom<T>(factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		this.invokeFactory = () => synchronousComponent(
			factory(this.tui, theme, this.keybindings, () => { this.doneCalls++; }),
			"adapter factory is synchronous",
		);
		return Promise.reject<T>(this.error);
	}

	invokeLateFactory(): CustomComponent {
		const invoke = this.invokeFactory;
		assert.ok(invoke, "host retained the public factory");
		return invoke();
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
		answers: [
			{ questionIndex: 0, question: "Choose a route", kind: "option", answer: "Direct" },
			{ questionIndex: 1, question: "Choose checks", kind: "multi", answer: null, selected: [] },
		],
	});
});

test("future external editing stops the TUI before invocation and restores a forced render after success", async () => {
	const calls: string[] = [];
	const host = new FakeCustomHost((component) => {
		focusCustomForKeyboard(component);
		component.handleInput("driver draft");
		component.handleInput("\u0007");
	});
	const driver = createTuiQuestionPresentationDriver(host, undefined, async (draft) => {
		host.lifecycle.push(`editor:${draft}`);
		calls.push(draft);
		return "driver result";
	});
	const presenting = asPromise(driver.present(request()));
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
		focusCustomForKeyboard(component);
		component.handleInput("failure draft");
		component.handleInput("\u0007");
	});
	host.notifyHandler = (message, type) => { notices.push(`${type}:${message}`); };
	const driver = createTuiQuestionPresentationDriver(host,
		(key, fallback) => key === "editor.failed" ? "Editor fehlgeschlagen" : fallback,
		async (draft) => {
			host.lifecycle.push(`editor:${draft}`);
			calls.push(draft);
			throw new Error("editor rejected");
		});
	const presenting = asPromise(driver.present(request()));
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
		focusCustomForKeyboard(component);
		component.handleInput("original draft");
		component.handleInput("\u0007");
	});
	host.tui.startOverride = () => { throw undefined; };
	host.notifyHandler = (message, type) => { notices.push(`${type}:${message}`); };
	const presenting = asPromise(createTuiQuestionPresentationDriver(host, undefined, async () => "edited value").present(request()));
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

type ExternalEditorScenario = {
	name: string;
	calls: number;
	configure(host: FakeCustomHost): void;
	editor: () => Promise<string>;
};

const externalEditorScenarios: readonly ExternalEditorScenario[] = [
	{ name: "an undefined editor failure before a start error", calls: 1, configure(host) { host.tui.startOverride = () => { throw new Error("start"); }; }, editor: async () => { throw undefined; } },
	{ name: "an undefined stop failure before a start error", calls: 0, configure(host) { host.tui.stopOverride = () => { throw undefined; }; host.tui.startOverride = () => { throw new Error("start"); }; }, editor: async () => "unused" },
	{ name: "an undefined forced render failure after editor success", calls: 1, configure(host) { host.tui.requestRenderOverride = () => { throw undefined; }; }, editor: async () => "edited" },
	{ name: "an undefined start failure before a render error", calls: 1, configure(host) { host.tui.startOverride = () => { throw undefined; }; host.tui.requestRenderOverride = () => { throw new Error("render"); }; }, editor: async () => "edited" },
];

for (const scenario of externalEditorScenarios) {
	test(`driver wrapper preserves ${scenario.name}`, async () => {
		const host = new FakeCustomHost(() => {});
		let calls = 0;
		scenario.configure(host);
		const { externalEditor, cleanup } = await captureDriverExternalEditor(host, async () => {
			calls++;
			return scenario.editor();
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

test("requests a full-width terminal-capped bottom-centered public overlay for the questionnaire", async () => {
	const host = new FakeCustomHost((component) => component.handleInput("\u001b"));
	await createTuiQuestionPresentationDriver(host).present(request());
	assert.deepEqual(host.receivedOptions.map((received) => {
		assert.ok(received, "the driver supplies custom overlay options");
		const { onHandle, ...options } = received;
		return options;
	}), [{
		overlay: true,
		overlayOptions: { width: "100%", maxHeight: "100%", anchor: "bottom-center", margin: 0 },
	}], "the host receives the unchanged public full-width terminal-capped overlay contract");
	assert.equal(typeof host.receivedOptions[0]?.onHandle, "function", "the driver receives the public overlay handle at the top level");
});

test("public fullscreen overlay bounds stay bottom-anchored and route physical clicks", async () => {
	const host = new PublicTuiHost();
	host.tui.start();
	const presenting = asPromise(createTuiQuestionPresentationDriver(host).present(request()));
	try {
		await settleExternalEditor();
		const component = host.component;
		const handle = host.handle;
		assert.ok(component, "the public host creates the questionnaire view");
		assert.ok(handle, "the public host exposes the overlay handle");

		host.tui.renderNow(true);
		const initialBounds = handle.getBounds();
		assert.ok(initialBounds, "the public handle reports bounds after an actual TUI render");
		assert.ok(initialBounds.height > 0, "the rendered questionnaire has a measured height");
		assert.equal(initialBounds.row, host.terminal.rows - initialBounds.height, "the overlay is anchored to the terminal bottom");

		const resizedRows = 16;
		host.terminal.resize(resizedRows);
		host.tui.renderNow(true);
		const resizedBounds = handle.getBounds();
		assert.ok(resizedBounds, "the public handle reports bounds after resize rendering");
		assert.equal(resizedBounds.row, resizedRows - resizedBounds.height, "resize keeps the overlay bottom-anchored");
		assert.notEqual(resizedBounds.row, initialBounds.row, "resize moves the physical overlay row");

		const rendered = component.render(resizedBounds.width).map(stripTerminalSequences);
		const localY = rendered.findIndex((line) => line.includes("Cancel"));
		assert.ok(localY >= 0, "the actual rendered questionnaire exposes its cancel control");
		const cancelLine = rendered[localY]!;
		const cancelStart = cancelLine.indexOf("Cancel");
		assert.ok(cancelStart >= 0, "the cancel control has a physical text column");
		assert.ok(localY < resizedBounds.height, "the routed control is inside the measured overlay");
		const localX = visibleWidth(cancelLine.slice(0, cancelStart));
		assert.ok(localX >= 0 && localX < resizedBounds.width, "the routed control is inside the measured width");

		const outsideY = resizedBounds.row > 0 ? resizedBounds.row - 1 : resizedBounds.row + resizedBounds.height;
		assert.ok(outsideY >= 0 && outsideY < host.terminal.rows, "the fixture leaves a physical row outside the overlay");
		feedSgrClick(host.terminal, localX, outsideY);
		assert.equal(host.doneCalls, 0, "a physical click outside the overlay does not route to its controls");

		feedSgrClick(host.terminal, localX, resizedBounds.row + localY);
		await presenting;
		assert.equal(host.doneCalls, 1, "a physical click at bounds.row + localY routes to the cancel control");
		assert.deepEqual(owned(host.rawOutcome), { correlationId: "tui-driver-correlation", cancelled: true, answers: [] });
	} finally {
		if (host.doneCalls === 0) host.component?.cancel();
		await presenting;
		host.tui.stop();
	}
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
	await assert.rejects(asPromise(createTuiQuestionPresentationDriver(host).present(request())), hostError);
	assert.equal(host.component!.render(48).length, 0);
	host.component!.handleInput("\u001b");
	assert.equal(host.doneCalls, 0);
});

test("propagates a real view-factory failure without a local fallback", async () => {
	const host = new FakeCustomHost(() => {}, undefined, new FailingTheme());
	await assert.rejects(asPromise(createTuiQuestionPresentationDriver(host).present(request())));
	assert.equal(host.calls, 1);
	assert.equal(host.component, undefined);
});

test("turns a synchronous custom throw after factory creation into a rejected promise and disposes it", async () => {
	const host = new SyncThrowAfterFactoryHost();
	let presenting: Promise<unknown> | undefined;
	assert.doesNotThrow(() => { presenting = asPromise(createTuiQuestionPresentationDriver(host).present(request())); });
	assert.ok(presenting, "the driver returns a promise even when the host throws synchronously");
	await assert.rejects(presenting, host.error);
	assert.equal(host.calls, 1);
	assert.equal(host.component!.render(48).length, 0);
	host.component!.handleInput("\u001b");
	assert.equal(host.doneCalls, 0);
});

test("rejects before a late retained factory can create a live view or forward completion", async () => {
	const host = new RejectBeforeLateFactoryHost();
	await assert.rejects(asPromise(createTuiQuestionPresentationDriver(host).present(request())), host.error);
	const component = host.invokeLateFactory();
	assert.deepEqual(component.render(48), []);
	component.handleInput?.("\u001b");
	assert.equal(host.calls, 1);
	assert.equal(host.doneCalls, 0);
});

class TrackingAbortSignal extends EventTarget implements AbortSignal {
	private readonly controller = new AbortController();
	addCalls = 0;
	removeCalls = 0;
	readonly listeners = new Set<EventTargetAddArguments[1]>();
	onabort: ((this: AbortSignal, ev: Event) => void) | null = null;

	get aborted(): boolean { return this.controller.signal.aborted; }
	get reason(): AbortSignal["reason"] { return this.controller.signal.reason; }

	override addEventListener(...args: EventTargetAddArguments): void {
		const [type, listener] = args;
		if (type === "abort" && listener !== null) {
			this.addCalls++;
			this.listeners.add(listener);
		}
		super.addEventListener(...args);
	}

	override removeEventListener(...args: EventTargetRemoveArguments): void {
		const [type, listener] = args;
		if (type === "abort" && listener !== null) {
			this.removeCalls++;
			this.listeners.delete(listener);
		}
		super.removeEventListener(...args);
	}

	throwIfAborted(): void { this.controller.signal.throwIfAborted(); }

	abort(reason?: unknown): void {
		if (this.aborted) return;
		this.controller.abort(reason);
		const event = new Event("abort");
		this.dispatchEvent(event);
		this.onabort?.call(this, event);
	}
}

class PreAbortedNoUiHost implements CustomHost {
	calls = 0;

	custom<T>(_factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		throw new Error("pre-aborted presentation must not show host UI");
	}
}

class DeferredFactoryHost implements CustomHost {
	readonly tui = new TestTui();
	readonly keybindings = testKeybindings;
	readonly error = new Error("deferred host settled");
	calls = 0;
	doneCalls = 0;
	private invokeFactory: (() => CustomComponent) | undefined;
	private rejectResult: ((reason?: unknown) => void) | undefined;

	custom<T>(factory: CustomFactory<T>, _options?: CustomOptions): Promise<T> {
		this.calls++;
		this.invokeFactory = () => synchronousComponent(
			factory(this.tui, theme, this.keybindings, () => { this.doneCalls++; }),
			"adapter factory is synchronous",
		);
		return new Promise<T>((_resolve, reject) => { this.rejectResult = reject; });
	}

	invokeLateFactory(): CustomComponent {
		const invoke = this.invokeFactory;
		assert.ok(invoke, "host retained the public factory");
		return invoke();
	}

	settle(): void {
		this.rejectResult?.(this.error);
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
	const presenting = asPromise(createTuiQuestionPresentationDriver(host).present(request(), signal));
	signal.abort();
	const component = host.invokeLateFactory();
	try {
		assert.deepEqual(component.render(48), []);
		component.handleInput?.("\u001b");
		assert.equal(host.doneCalls, 0);
	} finally {
		host.settle();
		await assert.rejects(presenting, host.error);
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
	await assert.rejects(asPromise(createTuiQuestionPresentationDriver(rejectedHost).present(request(), rejectedSignal)), rejectedHost.error);
	assert.equal(rejectedSignal.addCalls, 1);
	assert.equal(rejectedSignal.listeners.size, 0);
	assert.equal(rejectedSignal.removeCalls, 1);
});

class TestOverlayHandle implements OverlayHandle {
	hidden = false;
	focused = true;
	focusCalls = 0;
	readonly setHiddenCalls: boolean[] = [];

	hide(): void {}
	setHidden(hidden: boolean): void {
		this.hidden = hidden;
		this.setHiddenCalls.push(hidden);
	}
	isHidden(): boolean { return this.hidden; }
	focus(): void {
		this.focused = true;
		this.focusCalls++;
	}
	unfocus(_options?: OverlayUnfocusOptions): void { this.focused = false; }
	isFocused(): boolean { return this.focused; }
	getBounds(): undefined { return undefined; }
}

class RawOverlayHost implements CustomHost, Pick<ExtensionUIContext, "onTerminalInput"> {
	readonly tui = new TestTui();
	readonly keybindings: KeybindingsManager;
	readonly listeners = new Set<TerminalInputHandler>();
	readonly handle = new TestOverlayHandle();
	component: QuestionnaireTuiPresentation | undefined;
	doneCalls = 0;
	onHandleCalls = 0;
	onTerminalInputCalls = 0;
	removeCalls = 0;
	registrationError: Error | undefined;
	customError: Error | undefined;
	deferHandle = false;
	private pendingHandle: ((handle: OverlayHandle) => void) | undefined;

	constructor(keybindings: KeybindingsManager = testKeybindings) {
		this.keybindings = keybindings;
	}

	onTerminalInput(handler: TerminalInputHandler): () => void {
		this.onTerminalInputCalls++;
		if (this.registrationError) throw this.registrationError;
		this.listeners.add(handler);
		return () => { this.removeCalls++; this.listeners.delete(handler); };
	}

	custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
		let resolve: ((result: T | PromiseLike<T>) => void) | undefined;
		const result = new Promise<T>((done) => { resolve = done; });
		const component = synchronousComponent(factory(this.tui, theme, this.keybindings, (outcome) => {
			this.doneCalls++;
			resolve?.(outcome);
		}), "the questionnaire factory remains synchronous");
		this.component = questionnaireComponent(component);
		if (options?.onHandle) {
			const deliver = (handle: OverlayHandle) => { this.onHandleCalls++; options.onHandle?.(handle); };
			if (this.deferHandle) this.pendingHandle = deliver;
			else deliver(this.handle);
		}
		if (this.customError) throw this.customError;
		return result;
	}

	deliverLateHandle() { this.pendingHandle?.(this.handle); }
	raw(data: string) { return [...this.listeners].map((listener) => listener(data)).at(-1); }
}

function customOnlyUi(host: RawOverlayHost): CustomHost {
	return {
		custom<T>(factory: CustomFactory<T>, options?: CustomOptions): Promise<T> {
			return host.custom(factory, options);
		},
	};
}

async function startRawOverlay(host: RawOverlayHost, ui: CustomHost & Partial<Pick<ExtensionUIContext, "onTerminalInput">> = host) {
	const presenting = asPromise(createTuiQuestionPresentationDriver(ui).present(request()));
	await Promise.resolve();
	assert.ok(host.component, "the public custom factory created the questionnaire");
	return { presenting, cleanup: async () => { host.component?.cancel(); await presenting; } };
}

test("raw Ctrl+] collapses a focused overlay, consumes once, then restores focus without settling", async () => {
	const host = new RawOverlayHost();
	const { presenting, cleanup } = await startRawOverlay(host);
	try {
		assert.equal(host.onTerminalInputCalls, 1, "an active questionnaire installs one public raw-input listener");
		assert.equal(host.onHandleCalls, 1, "the driver receives the public overlay handle");
		assert.deepEqual(host.raw("\u001d"), { consume: true }, "the raw handler consumes the configured key before component routing");
		assert.deepEqual(host.handle.setHiddenCalls, [true]);
		assert.equal(host.doneCalls, 0, "collapse leaves the questionnaire promise pending");
		assert.deepEqual(host.raw("\u001d"), { consume: true });
		assert.deepEqual(host.handle.setHiddenCalls, [true, false]);
		assert.equal(host.handle.focusCalls, 1, "expansion restores overlay focus through OverlayHandle.focus()");
		assert.equal(host.doneCalls, 0);
	} finally { await cleanup(); }
	await presenting;
	assert.equal(host.removeCalls, 1, "normal cancellation removes the raw listener exactly once");
	assert.equal(host.raw("\u001d"), undefined, "a captured raw route is inert after settlement");
});

test("another focused overlay leaves Ctrl+] unconsumed and cannot hide the questionnaire", async () => {
	const host = new RawOverlayHost();
	const { cleanup } = await startRawOverlay(host);
	try {
		assert.equal(host.onTerminalInputCalls, 1, "the active questionnaire still registers its scoped raw listener");
		assert.equal(host.onHandleCalls, 1, "the public overlay handle is available for focus checks");
		host.handle.focused = false;
		assert.equal(host.raw("\u001d"), undefined, "the public raw listener leaves another overlay's key alone");
		assert.deepEqual(host.handle.setHiddenCalls, []);
		assert.match(host.component!.render(48).join("\n"), /Question 1:/, "the questionnaire remains expanded");
	} finally { await cleanup(); }
});

test("without raw input, Ctrl+] retains the visible one-line fallback and never hides the public handle", async () => {
	const host = new RawOverlayHost();
	const { cleanup } = await startRawOverlay(host, customOnlyUi(host));
	try {
		assert.equal(host.onTerminalInputCalls, 0, "an unavailable public hook is not registered");
		assert.equal(host.onHandleCalls, 1, "the fallback still receives a public overlay handle without hiding it");
		host.component!.handleInput("\u001d");
		assert.deepEqual(host.handle.setHiddenCalls, [], "a handle alone must never make the collapsed view unrecoverable");
		assert.deepEqual(host.component!.render(48).map((line) => stripTerminalSequences(line).trim()).filter(Boolean), ["Ctrl+] to expand · Esc to cancel"]);
	} finally { await cleanup(); }
});

test("hidden Escape cancels once through raw input without forwarding Escape to the view", async () => {
	const host = new RawOverlayHost();
	const { cleanup } = await startRawOverlay(host);
	try {
		assert.equal(host.onTerminalInputCalls, 1);
		assert.deepEqual(host.raw("\u001d"), { consume: true });
		assert.deepEqual(host.raw("\u001b"), { consume: true }, "hidden Escape is owned by the questionnaire listener");
		assert.equal(host.doneCalls, 1);
		assert.deepEqual(host.raw("\u001b"), undefined, "a settled listener cannot cancel a second time");
	} finally { await cleanup(); }
});

test("raw routing declines Ctrl+] during an active bracketed paste so the focused view keeps literal data", async () => {
	const host = new RawOverlayHost();
	const { cleanup } = await startRawOverlay(host);
	try {
		assert.equal(host.onTerminalInputCalls, 1);
		focusCustomForKeyboard(host.component!);
		assert.equal(host.raw("\u001b[200~before"), undefined, "paste framing is not a collapse shortcut");
		host.component!.handleInput("\u001b[200~before");
		assert.equal(host.raw("\u001d"), undefined, "the raw listener yields configured input while the view owns a paste");
		host.component!.handleInput("\u001dafter\u001b[201~");
		host.component!.handleInput("\u001b");
		assert.match(host.component!.render(48).join("\n"), /before.*after/s);
		assert.deepEqual(host.handle.setHiddenCalls, []);
	} finally { await cleanup(); }
});

test("abort removes the active raw listener exactly once before the cancelled presentation settles", async () => {
	const host = new RawOverlayHost();
	const signal = new AbortController();
	const presenting = asPromise(createTuiQuestionPresentationDriver(host).present(request(), signal.signal));
	try {
		await Promise.resolve();
		assert.equal(host.onTerminalInputCalls, 1);
		signal.abort();
		await presenting;
		assert.equal(host.removeCalls, 1);
		assert.equal(host.listeners.size, 0);
		assert.equal(host.raw("\u001d"), undefined);
	} finally {
		signal.abort();
		await presenting;
	}
});

test("submit removes the active raw listener exactly once before the questionnaire promise settles", async () => {
	const host = new RawOverlayHost();
	const { presenting, cleanup } = await startRawOverlay(host);
	try {
		assert.equal(host.onTerminalInputCalls, 1);
		host.component!.handleInput("\r");
		host.component!.handleInput("s");
		await presenting;
		assert.equal(host.removeCalls, 1);
		assert.equal(host.listeners.size, 0);
	} finally { await cleanup(); }
});

test("a host rejection removes the registered raw listener without manufacturing a cancellation", async () => {
	const host = new RawOverlayHost();
	const error = new Error("host rejected questionnaire");
	host.customError = error;
	await assert.rejects(asPromise(createTuiQuestionPresentationDriver(host).present(request())), error);
	assert.equal(host.onTerminalInputCalls, 1);
	assert.equal(host.removeCalls, 1);
	assert.equal(host.doneCalls, 0);
	assert.equal(host.listeners.size, 0);
});

test("a late overlay handle after cancellation cannot revive hidden state or a raw listener", async () => {
	const host = new RawOverlayHost();
	host.deferHandle = true;
	const { cleanup } = await startRawOverlay(host);
	try {
		assert.equal(host.onTerminalInputCalls, 1);
		assert.equal(host.onHandleCalls, 0, "the fake host retains the public callback until after termination");
	} finally {
		await cleanup();
	}
	host.deliverLateHandle();
	assert.equal(host.onHandleCalls, 1);
	assert.deepEqual(host.handle.setHiddenCalls, []);
	assert.equal(host.listeners.size, 0);
});

test("visible focused overlays route cancellation through the same injected public manager", async () => {
	const keybindings = localKeybindings({ "tui.select.cancel": "ctrl+q" });
	let doneAfterEscape = -1;
	const host = new FakeCustomHost((component) => {
		component.focused = true;
		component.handleInput(ESCAPE);
		doneAfterEscape = host.doneCalls;
		component.handleInput(CTRL_Q);
	}, undefined, theme, keybindings);
	const outcome = owned(await createTuiQuestionPresentationDriver(host).present(request()));
	assert.equal(doneAfterEscape, 0, "visible Escape is not a global cancel after the remap");
	assert.equal(host.received[0]?.keybindings, keybindings, "the factory and view share the injected manager instance");
	assert.deepEqual(keybindings.getUserBindings(), { "tui.select.cancel": "ctrl+q" });
	assert.deepEqual(testKeybindings.getUserBindings(), {}, "per-test overrides do not mutate the shared fixture manager");
	assert.deepEqual(outcome, { correlationId: "tui-driver-correlation", cancelled: true, answers: [] });
});

test("a visible unfocused overlay leaves configured cancellation bytes untouched on the raw route", async () => {
	const host = new RawOverlayHost(localKeybindings({ "tui.select.cancel": "ctrl+q" }));
	const { cleanup } = await startRawOverlay(host);
	try {
		host.handle.focused = false;
		assert.equal(host.raw(CTRL_Q), undefined, "raw input does not steal a visible unfocused overlay's key");
		assert.equal(host.raw(ESCAPE), undefined, "the old Escape byte also remains outside the raw route");
		assert.equal(host.doneCalls, 0);
	} finally { await cleanup(); }
});

test("a hidden overlay consumes remapped cancellation once while preserving collapse recovery", async () => {
	const host = new RawOverlayHost(localKeybindings({ "tui.select.cancel": "ctrl+q" }));
	const { cleanup } = await startRawOverlay(host);
	try {
		assert.deepEqual(host.raw(COLLAPSE), { consume: true });
		assert.equal(host.handle.isHidden(), true);
		assert.equal(host.raw(ESCAPE), undefined, "old Escape does not cancel a hidden remapped questionnaire");
		assert.equal(host.doneCalls, 0);
		assert.deepEqual(host.raw(COLLAPSE), { consume: true }, "the raw collapse key still expands a hidden questionnaire");
		assert.deepEqual(host.handle.setHiddenCalls, [true, false]);
		assert.equal(host.handle.focusCalls, 1, "raw expansion still restores overlay focus");
		assert.deepEqual(host.raw(COLLAPSE), { consume: true }, "collapse remains available after recovery");
		assert.deepEqual(host.raw(KITTY_CTRL_Q_REPEAT), { consume: true });
		assert.deepEqual(host.raw(KITTY_CTRL_Q_RELEASE), { consume: true });
		assert.equal(host.doneCalls, 0, "repeat and release cannot settle the hidden questionnaire");
		assert.deepEqual(host.raw(CTRL_Q), { consume: true }, "the configured cancel is consumed by the hidden overlay");
		assert.equal(host.doneCalls, 1);
		assert.equal(host.component!.render(48).length, 0, "hidden cancellation disposes the view without forwarding input");
		assert.equal(host.raw(CTRL_Q), undefined, "a settled raw listener cannot cancel a second time");
	} finally { await cleanup(); }
});

test("an empty cancellation binding leaves hidden Escape and Ctrl+C available to other input owners", async () => {
	const host = new RawOverlayHost(localKeybindings({ "tui.select.cancel": [] }));
	const { cleanup } = await startRawOverlay(host);
	try {
		assert.deepEqual(host.raw(COLLAPSE), { consume: true });
		assert.equal(host.raw(ESCAPE), undefined);
		assert.equal(host.raw(CTRL_C), undefined);
		assert.equal(host.doneCalls, 0, "disabled global cancellation does not settle hidden input");
		assert.deepEqual(host.raw(COLLAPSE), { consume: true }, "the hidden recovery key remains usable");
	} finally { await cleanup(); }
});

test("a throwing raw-listener registration fails closed, retains the visible fallback, and leaks no listener", async () => {
	const host = new RawOverlayHost();
	host.registrationError = new Error("raw input unavailable");
	const { cleanup } = await startRawOverlay(host);
	try {
		assert.equal(host.onTerminalInputCalls, 1);
		assert.equal(host.listeners.size, 0, "a failed registration owns no live callback");
		assert.equal(host.onHandleCalls, 1);
		host.component!.handleInput("\u001d");
		assert.deepEqual(host.handle.setHiddenCalls, [], "failure cannot hide the only recoverable view");
	} finally { await cleanup(); }
});
