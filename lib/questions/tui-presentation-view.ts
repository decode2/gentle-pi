import {
	Box,
	CURSOR_MARKER,
	Editor,
	Markdown,
	isKeyRelease,
	isKeyRepeat,
	matchesKey,
	parseKey,
	Text,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
	stripTerminalSequences,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { NativeFullscreenInteraction } from "../native-fullscreen-interaction.ts";
import { NativePointerScope, type NativePointerMouseObserver } from "../native-pointer-region.ts";
import type { FrozenQuestionnaireRequest, RawQuestionnaireOutcome } from "./contract.ts";
import type { QuestionnaireExternalEditor } from "./external-editor.ts";
import type { QuestionnaireLocalizer } from "./localization.ts";
import { QuestionOptionControl, type QuestionOptionControlAction } from "./option-control.ts";
import {
	createQuestionnairePresentationState,
	reduceQuestionnairePresentation,
	toRawQuestionnaireOutcome,
	type QuestionnairePresentationAction,
	type QuestionnairePresentationState,
} from "./presentation-state.ts";

type FullscreenMouseResult = ReturnType<NativeFullscreenInteraction["handleMouse"]>;

export interface QuestionnaireTuiPresentationTheme {
	fg(color: "accent" | "muted" | "dim" | "text" | "success" | "warning", text: string): string;
	bg(color: "selectedBg", text: string): string;
	bold(text: string): string;
}

export interface QuestionnaireTuiPresentationOptions {
	readonly request: FrozenQuestionnaireRequest;
	readonly tui: TUI;
	readonly theme: QuestionnaireTuiPresentationTheme;
	readonly keybindings?: KeybindingsManager;
	readonly localize?: QuestionnaireLocalizer;
	readonly externalEditor?: QuestionnaireExternalEditor;
	readonly onExternalEditorError?: (message: string) => void;
	readonly collapseKey?: string;
	readonly onCollapseChange?: (collapsed: boolean) => void;
	readonly onDone: (outcome: RawQuestionnaireOutcome) => void;
}

type Editing = "custom" | "question-note" | "global-note" | undefined;

type KeyboardFocusTarget =
	| { readonly type: "option"; readonly id: string }
	| { readonly type: "custom" }
	| { readonly type: "question-note" }
	| { readonly type: "global-note" }
	| { readonly type: "primary" }
	| { readonly type: "cancel" };

type SelectKeybinding = "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel";

/** Fullscreen presentation only; its driver adapter remains deliberately separate. */
export class QuestionnaireTuiPresentation extends NativeFullscreenInteraction implements Focusable {
	private readonly presentationOptions: QuestionnaireTuiPresentationOptions;
	private state: QuestionnairePresentationState;
	private pointerScope = new NativePointerScope();
	private optionControl: QuestionOptionControl | undefined;
	private optionControlQuestionIndex: number | undefined;
	private optionLayout: QuestionOptionPreviewLayout | undefined;
	private optionFocus: { readonly questionIndex: number; readonly id: string } | undefined;
	private editor: Editor | undefined;
	private editorQuestionIndex: number | undefined;
	private editing: Editing;
	private pasteActive = false;
	private pasteBuffer = "";
	private renderedWidth: number | undefined;
	private renderedTerminalRows: number | undefined;
	private renderedHeight: number | undefined;
	private bodyScrollTop = 0;
	private documentHeight = 0;
	private footerStart = 0;
	private bodyVirtualHeight = 0;
	private bodyVisibleHeight = 0;
	private bodyContentHeight = 0;
	private followEditorCursor = false;
	private followKeyboardFocus = false;
	private pointerFocusRefreshPending = false;
	private lastLayoutWidth: number | undefined;
	private lastLayoutTerminalRows: number | undefined;
	private hoveredFooter: "primary" | "cancel" | undefined;
	private rebuilding = false;
	private finishing = false;
	private disposed = false;
	private externalEditorPending: { readonly editor: Editor; readonly questionIndex: number } | undefined;
	private readonly collapseKey: string | undefined;
	private readonly collapseMatchKey: string | undefined;
	private collapsed = false;
	private keyboardFocus: KeyboardFocusTarget = { type: "option", id: "0" };
	private _focused = false;

	get focused(): boolean { return this._focused; }
	set focused(value: boolean) {
		this._focused = value;
		if (this.editor) this.editor.focused = value;
		if (value) this.followEditorCursor = true;
	}

	constructor(options: QuestionnaireTuiPresentationOptions) {
		let view: QuestionnaireTuiPresentation;
		super({
		keyboardTarget: {
			render: () => [], invalidate: () => {}, handleInput: (data) => view.routeInput(data),
		},
		requestRender: () => options.tui.requestRender(),
		mouseObserver: {
			beforeMouse: (event) => view.observeMouse("beforeMouse", event),
			afterMouse: (event) => view.observeMouse("afterMouse", event),
		},
		});
		view = this;
		this.presentationOptions = options;
		const collapseKey = normalizeCollapseKey(options.collapseKey);
		this.collapseKey = collapseKey === "off" ? undefined : collapseKey ?? "ctrl+]";
		this.collapseMatchKey = matchingKeyId(this.collapseKey);
		this.state = createQuestionnairePresentationState(options.request);
		this.rebuild();
	}

	override handleInput(data: string): void {
		if (!this.disposed) super.handleInput(data);
	}

	override handleMouse(event: TuiMouseEvent): FullscreenMouseResult {
		if (this.disposed || this.collapsed || this.renderedWidth === undefined || this.renderedTerminalRows === undefined || this.renderedHeight === undefined ||
			Math.max(0, Math.floor(this.presentationOptions.tui.terminal.rows)) !== this.renderedTerminalRows ||
			event.width !== this.renderedWidth || event.height !== this.renderedHeight ||
			event.x < 0 || event.x >= this.renderedWidth || event.y < 0 || event.y >= this.renderedHeight) return undefined;
		const controls = Math.min(this.renderedHeight, 2);
		const footerGap = this.renderedHeight > controls ? 1 : 0;
		if (event.type === "wheel") {
			if (event.y >= this.bodyVisibleHeight || !event.wheelDelta) return undefined;
			this.followKeyboardFocus = false;
			const documentY = this.bodyScrollTop + event.y;
			if (this.optionLayout && documentY >= 0 && documentY < this.documentHeight) {
				const preview = super.handleMouse({ ...event, y: documentY, height: this.documentHeight });
				if (preview?.handled) return preview;
			}
			const maximum = Math.max(0, this.bodyVirtualHeight - this.bodyVisibleHeight);
			const next = Math.max(0, Math.min(maximum, this.bodyScrollTop + (event.wheelDelta < 0 ? -1 : 1)));
			const changed = next !== this.bodyScrollTop;
			this.bodyScrollTop = next;
			if (changed && this.editing) this.followEditorCursor = false;
			return this.handledMouseResult(event, changed);
		}
		if (event.y < this.bodyVisibleHeight && event.y >= this.bodyContentHeight) {
			if (event.type === "move") {
				this.observeMouse("beforeMouse", event);
				this.observeMouse("afterMouse", event);
			}
			return this.handledMouseResult(event, true);
		}
		if (footerGap > 0 && event.y === this.bodyVisibleHeight) {
			if (event.type === "move") {
				this.observeMouse("beforeMouse", event);
				this.observeMouse("afterMouse", event);
			}
			return this.handledMouseResult(event, true);
		}
		const footerY = event.y - this.bodyVisibleHeight - footerGap;
		const documentY = event.y < this.bodyVisibleHeight
			? this.bodyScrollTop + event.y
			: this.documentHeight - controls + footerY;
		if (documentY < 0 || documentY >= this.documentHeight) return undefined;
		return super.handleMouse({ ...event, y: documentY, height: this.documentHeight });
	}

	override render(width: number): string[] {
		if (this.disposed) return [];
		if (this.pointerFocusRefreshPending) {
			this.pointerFocusRefreshPending = false;
			this.rebuild();
		}
		const bounded = Math.max(0, Math.floor(width));
		const terminalRows = Math.max(0, Math.floor(this.presentationOptions.tui.terminal.rows));
		const resized = this.lastLayoutWidth !== undefined &&
			(bounded !== this.lastLayoutWidth || terminalRows !== this.lastLayoutTerminalRows);
		if (resized) this.followKeyboardFocus = true;
		this.lastLayoutWidth = bounded;
		this.lastLayoutTerminalRows = terminalRows;
		this.optionLayout?.setPreviewViewportRows(terminalRows);
		if (this.collapsed) {
			if (bounded === 0 || terminalRows === 0) return [];
			this.renderedWidth = bounded;
			this.renderedTerminalRows = terminalRows;
			this.renderedHeight = 1;
			const cancelHint = this.cancellationHint();
			const hint = this.localize("chrome.collapsed.hint", "{key} to expand{cancelHint}")
				.replaceAll("{key}", formatCollapseKey(this.collapseKey))
				.replaceAll("{cancelHint}", cancelHint.length > 0 ? ` · ${cancelHint}` : "");
			return [truncateToWidth(this.presentationOptions.theme.fg("dim", hint), bounded)];
		}
		if (bounded !== this.renderedWidth || terminalRows !== this.renderedTerminalRows) {
			this.renderedWidth = undefined;
			this.renderedTerminalRows = undefined;
			this.renderedHeight = undefined;
			if (this.editing && this.focused) this.followEditorCursor = true;
			this.pointerScope.invalidate();
		}
		if (bounded === 0 || terminalRows === 0) return [];
		const document = super.render(bounded).map((line) => truncateToWidth(line, bounded, ""));
		this.documentHeight = document.length;
		this.footerStart = Math.max(0, document.length - 2);
		this.bodyVirtualHeight = this.footerStart;
		const height = Math.min(terminalRows, this.bodyVirtualHeight + 3);
		const controls = Math.min(height, 2);
		const footerGap = height > controls ? 1 : 0;
		this.bodyVisibleHeight = height - controls - footerGap;
		const maximum = Math.max(0, this.bodyVirtualHeight - this.bodyVisibleHeight);
		this.bodyScrollTop = Math.max(0, Math.min(maximum, this.bodyScrollTop));
		const markerLine = document.findIndex((line) => line.includes(CURSOR_MARKER));
		if (this.followEditorCursor && markerLine >= 0 && markerLine < this.footerStart && this.bodyVisibleHeight > 0) {
			const lastVisible = this.bodyScrollTop + this.bodyVisibleHeight - 1;
			if (markerLine < this.bodyScrollTop) this.bodyScrollTop = markerLine;
			else if (markerLine > lastVisible) this.bodyScrollTop = markerLine - this.bodyVisibleHeight + 1;
			this.bodyScrollTop = Math.max(0, Math.min(maximum, this.bodyScrollTop));
		}
		if (this.followKeyboardFocus && (this.keyboardFocus.type === "primary" || this.keyboardFocus.type === "cancel")) {
			this.followKeyboardFocus = false;
		}
		if (this.followKeyboardFocus && !this.editing && this.keyboardFocus.type !== "primary" && this.keyboardFocus.type !== "cancel" && this.bodyVisibleHeight > 0) {
			const keyboardFocusLine = document.findIndex((line) => stripTerminalSequences(line).trim().startsWith("→ "));
			if (keyboardFocusLine >= 0 && keyboardFocusLine < this.footerStart) {
				const lastVisible = this.bodyScrollTop + this.bodyVisibleHeight - 1;
				if (keyboardFocusLine < this.bodyScrollTop) this.bodyScrollTop = keyboardFocusLine;
				else if (keyboardFocusLine > lastVisible) this.bodyScrollTop = keyboardFocusLine - this.bodyVisibleHeight + 1;
				this.bodyScrollTop = Math.max(0, Math.min(maximum, this.bodyScrollTop));
				this.followKeyboardFocus = false;
			}
		}
		const body = document.slice(this.bodyScrollTop, Math.min(this.footerStart, this.bodyScrollTop + this.bodyVisibleHeight));
		this.bodyContentHeight = body.length;
		const footer = document.slice(Math.max(0, document.length - controls));
		const lines = [
			...body,
			...Array(Math.max(0, this.bodyVisibleHeight - body.length)).fill(""),
			...(footerGap > 0 ? [""] : []),
			...footer,
		];
		this.renderedWidth = bounded;
		this.renderedTerminalRows = terminalRows;
		this.renderedHeight = height;
		return lines;
	}

	override invalidate(): void {
		this.renderedWidth = undefined;
		this.renderedTerminalRows = undefined;
		this.renderedHeight = undefined;
		this.pointerScope.invalidate();
		this.optionControl?.invalidate();
		super.invalidate();
	}

	cancel(): void {
		this.finish({ type: "cancel" });
	}

	isCollapseEnabled(): boolean {
		return this.collapseMatchKey !== undefined;
	}

	isCollapsed(): boolean {
		return this.collapsed;
	}

	consumeRawCancellationInput(data: string): boolean {
		if (this.disposed || this.pasteActive || !this.matchesSelectKey(data, "tui.select.cancel")) return false;
		if (!isKeyRelease(data) && !isKeyRepeat(data)) this.cancel();
		return true;
	}

	consumeRawCollapseInput(data: string): boolean {
		if (this.disposed || this.pasteActive || !this.matchesCollapseKey(data)) return false;
		if (!isKeyRelease(data) && !isKeyRepeat(data)) this.toggleCollapsed();
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.renderedWidth = undefined;
		this.renderedTerminalRows = undefined;
		this.renderedHeight = undefined;
		this.pasteActive = false;
		this.pasteBuffer = "";
		this.externalEditorPending = undefined;
		if (this.editor) this.editor.onChange = undefined;
		this.editor = undefined;
		this.editorQuestionIndex = undefined;
		this.retireOptionControl();
		this.pointerScope.dispose();
		super.clear();
	}

	private routeInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		if (this.collapsed) {
			if (this.matchesCollapseKey(data)) {
				if (!isKeyRepeat(data)) this.toggleCollapsed();
			} else if (this.matchesSelectKey(data, "tui.select.cancel")) {
				if (!isKeyRepeat(data)) this.finish({ type: "cancel" });
			}
			return;
		}
		if (this.editing && (this.pasteActive || data.includes("\u001b[200~"))) return this.handleEditorInput(data);
		if (this.matchesCollapseKey(data)) {
			if (!isKeyRepeat(data)) this.toggleCollapsed();
			return;
		}
		if (this.editing) {
			if (this.handleEditorInputKey(data)) return;
			else if (this.editing === "custom" && this.handleCustomEditorDelete(data)) return;
			else if (this.editing === "custom" && this.matchesExternalEditorKey(data)) this.launchExternalEditor();
			else if (this.matchesInputKey(data, "tui.input.tab")) this.moveKeyboardFocusFromEditor(1);
			else if (matchesKey(data, "shift+tab")) this.moveKeyboardFocusFromEditor(-1);
			else if (this.matchesSelectKey(data, "tui.select.cancel") || matchesKey(data, "escape")) {
				if (isKeyRepeat(data)) return;
				const target: KeyboardFocusTarget = this.editing === "custom" ? { type: "custom" }
					: this.editing === "question-note" ? { type: "question-note" } : { type: "global-note" };
				this.closeEditor();
				this.setKeyboardFocus(target);
			} else this.handleEditorInput(data);
			return;
		}
		// Ctrl+PageUp/PageDown are not used by the options control or fullscreen navigation;
		// editing returns above first so the SDK Editor retains its page bindings.
		if (matchesKey(data, "ctrl+pageUp") || matchesKey(data, "ctrl+pageDown")) {
			const direction: -1 | 1 = matchesKey(data, "ctrl+pageUp") ? -1 : 1;
			this.optionLayout?.scrollPreviewPage(direction);
			return;
		}
		if (this.matchesSelectKey(data, "tui.select.up")) return this.moveKeyboardFocus(-1);
		if (this.matchesSelectKey(data, "tui.select.down")) return this.moveKeyboardFocus(1);
		if (this.matchesInputKey(data, "tui.input.tab")) return this.moveKeyboardFocus(1);
		if (matchesKey(data, "shift+tab")) return this.moveKeyboardFocus(-1);
		if (this.matchesSelectKey(data, "tui.select.confirm")) return this.activateKeyboardFocus(data);
		if (this.matchesSelectKey(data, "tui.select.cancel")) {
			if (!isKeyRepeat(data)) this.finish({ type: "cancel" });
			return;
		}
		if (data === "[") return this.focusQuestion(this.state.activeQuestionIndex - 1, true);
		if (data === "]") return this.focusQuestion(this.state.activeQuestionIndex + 1, true);
		if (data === "n") return this.activatePrimary(true);
		if (data === "s") return this.submitCurrent();
		this.optionControl?.handleInput(data);
	}

	private observeMouse(method: "beforeMouse" | "afterMouse", event: TuiMouseEvent): void {
		this.pointerScope.createMouseObserver(() => this.presentationOptions.tui.requestRender())[method](event);
		const optionObserver = this.optionLayout?.createMouseObserver(() => this.presentationOptions.tui.requestRender())
			?? this.optionControl?.createMouseObserver(() => this.presentationOptions.tui.requestRender());
		optionObserver?.[method](event);
	}

	private matchesCollapseKey(data: string): boolean {
		return this.collapseMatchKey !== undefined && matchingKeyId(parseKey(data)) === this.collapseMatchKey;
	}

	private toggleCollapsed(): void {
		this.collapsed = !this.collapsed;
		this.rebuild();
		this.presentationOptions.onCollapseChange?.(this.collapsed);
		this.presentationOptions.tui.requestRender();
	}

	private dispatch(action: QuestionnairePresentationAction): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		if (action.type === "next") this.persistEditor();
		const next = reduceQuestionnairePresentation(this.state, action);
		if (next === this.state) return;
		this.state = next;
		this.rebuild();
		this.presentationOptions.tui.requestRender();
	}

	private finish(action: Extract<QuestionnairePresentationAction, { type: "cancel" | "submit-partial" }>): void {
		if (this.disposed || this.finishing) return;
		this.finishing = true;
		this.persistEditor();
		this.state = reduceQuestionnairePresentation(this.state, action);
		const outcome = toRawQuestionnaireOutcome(this.state);
		this.dispose();
		this.presentationOptions.onDone(outcome);
	}

	private focusQuestion(index: number, followKeyboardFocus = false): void {
		if (index < 0 || index >= this.state.request.questions.length || index === this.state.activeQuestionIndex) return;
		this.followKeyboardFocus = followKeyboardFocus;
		this.closeEditor();
		this.keyboardFocus = this.state.tabs[index] === "custom" ? { type: "custom" } : { type: "option", id: "0" };
		this.dispatch({ type: "focus-question", questionIndex: index });
	}

	private setTab(tab: "options" | "custom"): void {
		const index = this.state.activeQuestionIndex;
		if (tab === "options") {
			if (this.editing === "custom") this.closeEditor(false);
			this.setKeyboardFocus(this.rememberedOptionTarget());
			if (this.state.tabs[index] !== "options") this.dispatch({ type: "set-tab", questionIndex: index, tab });
			return;
		}
		if (this.editing === "custom" && this.state.tabs[index] === "custom") return;
		this.setKeyboardFocus({ type: "custom" });
		if (this.state.tabs[index] !== "custom") this.dispatch({ type: "set-tab", questionIndex: index, tab });
		this.openEditor("custom");
	}

	private moveKeyboardFocusFromEditor(delta: -1 | 1): void {
		const origin: KeyboardFocusTarget = this.editing === "custom" ? { type: "custom" }
			: this.editing === "question-note" ? { type: "question-note" } : { type: "global-note" };
		this.closeEditor(false);
		this.keyboardFocus = origin;
		this.moveKeyboardFocus(delta);
	}

	private moveKeyboardFocus(delta: -1 | 1): void {
		this.keyboardFocus = this.normalizeKeyboardFocus(this.keyboardFocus);
		const current = this.keyboardFocusPosition();
		const next = Math.max(0, Math.min(this.keyboardFocusCount() - 1, current + delta));
		if (next === current) return;
		this.setKeyboardFocus(this.keyboardTargetAt(next), true);
	}

	private activateKeyboardFocus(data: string): void {
		switch (this.keyboardFocus.type) {
			case "option":
				this.optionControl?.handleInput(data);
				return;
			case "custom":
				this.setTab("custom");
				return;
			case "question-note":
				this.openEditor("question-note");
				return;
			case "global-note":
				this.openEditor("global-note");
				return;
			case "primary":
				this.activatePrimary(true);
				return;
			case "cancel":
				this.finish({ type: "cancel" });
				return;
		}
	}

	private cancellationHint(): string {
		const manager = this.presentationOptions.keybindings;
		const keys = manager ? manager.getKeys("tui.select.cancel") : ["escape", "ctrl+c"];
		if (keys.length === 0) return "";
		const keyLabels = keys.map((key) => formatCollapseKey(key)).join(" / ");
		return this.localize("chrome.navigation.escape", "{key} to cancel").replaceAll("{key}", keyLabels);
	}

	private matchesSelectKey(data: string, keybinding: SelectKeybinding): boolean {
		const manager = this.presentationOptions.keybindings;
		if (manager) return manager.matches(data, keybinding);
		if (keybinding === "tui.select.up") return matchesKey(data, "up");
		if (keybinding === "tui.select.down") return matchesKey(data, "down");
		if (keybinding === "tui.select.confirm") return matchesKey(data, "enter");
		return matchesKey(data, "escape") || matchesKey(data, "ctrl+c");
	}

	private matchesInputKey(data: string, keybinding: "tui.input.newLine" | "tui.input.submit" | "tui.input.tab" | "tui.editor.deleteToLineStart"): boolean {
		const manager = this.presentationOptions.keybindings;
		if (manager) return manager.matches(data, keybinding);
		if (keybinding === "tui.input.newLine") return matchesKey(data, "shift+enter") || matchesKey(data, "ctrl+j");
		if (keybinding === "tui.input.submit") return matchesKey(data, "enter");
		if (keybinding === "tui.input.tab") return matchesKey(data, "tab");
		return matchesKey(data, "ctrl+u");
	}

	private matchesExternalEditorKey(data: string): boolean {
		const manager = this.presentationOptions.keybindings;
		return manager ? manager.matches(data, "app.editor.external") : matchesKey(data, "ctrl+g");
	}

	private hasExplicitKeybinding(keybinding: string): boolean {
		const manager = this.presentationOptions.keybindings;
		return manager !== undefined && Object.prototype.hasOwnProperty.call(manager.getUserBindings(), keybinding);
	}

	private handleCustomEditorDelete(data: string): boolean {
		if (!this.matchesInputKey(data, "tui.editor.deleteToLineStart")) return false;
		this.editor!.setText("");
		return true;
	}

	private handleEditorInputKey(data: string): boolean {
		const inputBindingsConfigured = this.hasExplicitKeybinding("tui.input.newLine") || this.hasExplicitKeybinding("tui.input.submit");
		if (!inputBindingsConfigured) {
			if (matchesKey(data, "enter") || this.matchesInputKey(data, "tui.input.newLine")) {
				this.editor!.insertTextAtCursor("\n");
				return true;
			}
			return false;
		}
		if (this.matchesInputKey(data, "tui.input.newLine")) {
			this.editor!.insertTextAtCursor("\n");
			return true;
		}
		if (this.matchesInputKey(data, "tui.input.submit")) {
			this.confirmEditor();
			return true;
		}
		return false;
	}

	private confirmEditor(): void {
		const editing = this.editing;
		if (!this.editor || !editing) return;
		if (editing !== "custom") {
			const target: KeyboardFocusTarget = editing === "question-note" ? { type: "question-note" } : { type: "global-note" };
			this.closeEditor();
			this.setKeyboardFocus(target);
			return;
		}
		if (!this.isFinalQuestion()) {
			this.continueToNextQuestion(true);
			return;
		}
		this.persistEditor();
		if (this.hasExplicitActiveAnswer()) this.state = reduceQuestionnairePresentation(this.state, { type: "next" });
		this.closeEditor(false);
		this.setKeyboardFocus({ type: "primary" }, true);
	}

	private setKeyboardFocus(target: KeyboardFocusTarget, followKeyboardFocus = false): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		const previous = this.normalizeKeyboardFocus(this.keyboardFocus);
		const next = this.normalizeKeyboardFocus(target);
		const same = this.sameKeyboardFocus(previous, next);
		if (same) {
			if (!followKeyboardFocus) this.followKeyboardFocus = false;
			return;
		}
		this.followKeyboardFocus = followKeyboardFocus;
		const index = this.state.activeQuestionIndex;
		if (next.type === "option") {
			this.optionFocus = { questionIndex: index, id: next.id };
			if (this.editing) this.closeEditor(false);
		}
		this.keyboardFocus = next;
		if (next.type === "option" && this.state.tabs[index] !== "options") {
			this.state = reduceQuestionnairePresentation(this.state, { type: "set-tab", questionIndex: index, tab: "options" });
			this.rebuild();
			this.presentationOptions.tui.requestRender();
			return;
		}
		if (next.type === "option" && previous.type === "option" && this.optionControl) {
			this.optionControl.setFocusedId(next.id);
			this.presentationOptions.tui.requestRender();
			return;
		}
		this.rebuild();
		this.presentationOptions.tui.requestRender();
	}

	private keyboardFocusCount(): number {
		return this.keyboardFocusTargets().length;
	}

	private keyboardFocusPosition(): number {
		const targets = this.keyboardFocusTargets();
		const current: KeyboardFocusTarget = this.keyboardFocus.type === "option"
			? { type: "option", id: this.optionControl?.getFocusedOption()?.id ?? this.keyboardFocus.id }
			: this.keyboardFocus;
		const position = targets.findIndex((target) => this.sameKeyboardFocus(target, current));
		return position >= 0 ? position : 0;
	}

	private keyboardTargetAt(position: number): KeyboardFocusTarget {
		return this.keyboardFocusTargets()[position]!;
	}

	private keyboardFocusTargets(): KeyboardFocusTarget[] {
		const question = this.state.request.questions[this.state.activeQuestionIndex];
		const targets: KeyboardFocusTarget[] = question?.options.map((_, optionIndex) => ({
			type: "option" as const, id: String(optionIndex),
		})) ?? [];
		targets.push({ type: "custom" }, { type: "question-note" });
		if (this.isFinalQuestion()) targets.push({ type: "global-note" });
		targets.push({ type: "primary" }, { type: "cancel" });
		return targets;
	}

	private optionCount(): number {
		return this.state.request.questions[this.state.activeQuestionIndex]?.options.length ?? 0;
	}

	private optionIndex(id: string | undefined): number {
		if (id === undefined) return -1;
		const index = Number(id);
		return Number.isInteger(index) && index >= 0 && index < this.optionCount() && String(index) === id ? index : -1;
	}

	private rememberedOptionTarget(): KeyboardFocusTarget {
		const optionCount = this.optionCount();
		if (optionCount === 0) return { type: "custom" };
		const focusedId = this.optionControl?.getFocusedOption()?.id;
		const savedId = this.optionFocus?.questionIndex === this.state.activeQuestionIndex ? this.optionFocus.id : undefined;
		const index = this.optionIndex(focusedId ?? savedId);
		return { type: "option", id: String(index >= 0 ? index : 0) };
	}

	private normalizeKeyboardFocus(target: KeyboardFocusTarget): KeyboardFocusTarget {
		const targets = this.keyboardFocusTargets();
		const candidate = target.type !== "option" ? target : (() => {
			const targetIndex = this.optionIndex(target.id);
			if (targetIndex >= 0) return { type: "option", id: String(targetIndex) } as const;
			return this.rememberedOptionTarget();
		})();
		return targets.find((focus) => this.sameKeyboardFocus(focus, candidate)) ?? targets[0]!;
	}

	private sameKeyboardFocus(left: KeyboardFocusTarget, right: KeyboardFocusTarget): boolean {
		if (left.type !== right.type) return false;
		return left.type !== "option" || (right.type === "option" && left.id === right.id);
	}

	private activatePrimary(followKeyboardFocus = false): void {
		if (this.isFinalQuestion()) return this.submitCurrent();
		this.continueToNextQuestion(followKeyboardFocus);
	}

	private isFinalQuestion(): boolean {
		return this.state.activeQuestionIndex === this.state.request.questions.length - 1;
	}

	private continueToNextQuestion(followKeyboardFocus = false): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		this.persistEditor();
		if (!this.hasExplicitActiveAnswer()) return;
		this.followKeyboardFocus = followKeyboardFocus;
		const index = this.state.activeQuestionIndex;
		const committed = reduceQuestionnairePresentation(this.state, { type: "next" });
		if (committed === this.state) return;
		this.state = committed;
		this.closeEditor(false);
		this.state = reduceQuestionnairePresentation(this.state, { type: "focus-question", questionIndex: index + 1 });
		this.keyboardFocus = this.state.tabs[index + 1] === "custom" ? { type: "custom" } : { type: "option", id: "0" };
		this.bodyScrollTop = 0;
		this.rebuild();
		this.presentationOptions.tui.requestRender();
	}

	private submitCurrent(): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		this.persistEditor();
		if (this.hasExplicitActiveAnswer()) this.state = reduceQuestionnairePresentation(this.state, { type: "next" });
		this.finish({ type: "submit-partial" });
	}

	private hasExplicitActiveAnswer(): boolean {
		const index = this.state.activeQuestionIndex;
		if (this.state.tabs[index] === "custom") return this.state.customDrafts[index] !== undefined;
		const question = this.state.request.questions[index]!;
		return question.multiSelect ? true : this.state.optionSelections[index] !== undefined;
	}

	private openEditor(editing: Exclude<Editing, undefined>): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		if (editing === "custom" && this.state.tabs[this.state.activeQuestionIndex] !== "custom") return this.setTab("custom");
		this.closeEditor(false);
		this.editing = editing;
		const index = this.state.activeQuestionIndex;
		const initial = editing === "custom" ? this.state.customDrafts[index]
			: editing === "question-note" ? this.state.questionNotes[index] : this.state.globalNote;
		const editor = new Editor(this.presentationOptions.tui, editorTheme(this.presentationOptions.theme), { paddingX: 1 });
		this.editor = editor;
		this.editorQuestionIndex = index;
		this.followEditorCursor = true;
		editor.disableSubmit = true;
		editor.focused = this.focused;
		editor.onChange = () => {
			if (this.disposed || this.rebuilding || this.editor !== editor || this.editing !== editing || this.editorQuestionIndex !== index) return;
			let value = editor.getText();
			if (/[\t\r]/.test(value)) {
				editor.setText(value);
				value = editor.getText();
			}
			this.storeEditorValue(editing, index, value);
			this.presentationOptions.tui.requestRender();
		};
		editor.setText(initial ?? "");
		this.rebuild();
		this.presentationOptions.tui.requestRender();
	}

	private closeEditor(rebuild = true): void {
		if (!this.editor) return;
		this.persistEditor();
		this.editor.onChange = undefined;
		this.editor = undefined;
		this.editorQuestionIndex = undefined;
		this.editing = undefined;
		this.pasteActive = false;
		this.pasteBuffer = "";
		if (rebuild) this.rebuild();
		this.presentationOptions.tui.requestRender();
	}

	private launchExternalEditor(): void {
		const editor = this.editor;
		const questionIndex = this.editorQuestionIndex;
		const externalEditor = this.presentationOptions.externalEditor;
		if (!editor || !externalEditor || this.externalEditorPending || this.pasteActive || this.editing !== "custom" ||
			questionIndex === undefined || questionIndex !== this.state.activeQuestionIndex || this.state.tabs[questionIndex] !== "custom") return;
		const pending = { editor, questionIndex };
		this.externalEditorPending = pending;
		void this.runExternalEditor(pending, editor.getExpandedText(), externalEditor);
	}

	private async runExternalEditor(pending: { readonly editor: Editor; readonly questionIndex: number }, draft: string, externalEditor: QuestionnaireExternalEditor): Promise<void> {
		try {
			const edited = await externalEditor(draft);
			if (!this.isCurrentExternalEditor(pending)) return;
			pending.editor.setText(edited);
			this.storeEditorValue("custom", pending.questionIndex, pending.editor.getExpandedText());
			this.presentationOptions.tui.requestRender();
		} catch {
			if (!this.isCurrentExternalEditor(pending)) return;
			this.externalEditorPending = undefined;
			this.reportExternalEditorError();
		} finally {
			if (this.externalEditorPending === pending) this.externalEditorPending = undefined;
		}
	}

	private isCurrentExternalEditor(pending: { readonly editor: Editor; readonly questionIndex: number }): boolean {
		return !this.disposed && this.externalEditorPending === pending && this.editing === "custom" && this.editor === pending.editor &&
			this.editorQuestionIndex === pending.questionIndex && this.state.activeQuestionIndex === pending.questionIndex && this.state.tabs[pending.questionIndex] === "custom";
	}

	private reportExternalEditorError(): void {
		try {
			this.presentationOptions.onExternalEditorError?.(this.localize("editor.failed", "External editor failed"));
		} catch {
			// A notification failure must not escape a handled editor rejection.
		}
	}

	private handleEditorInput(data: string): void {
		if (data) this.followEditorCursor = true;
		const start = data.indexOf("\u001b[200~");
		if (!this.pasteActive && start === -1) return this.editor!.handleInput(data);
		let remaining = data;
		if (!this.pasteActive) {
			if (start > 0) this.editor!.handleInput(remaining.slice(0, start));
			this.pasteActive = true;
			remaining = remaining.slice(start + 6);
		}
		this.pasteBuffer += remaining;
		const end = this.pasteBuffer.indexOf("\u001b[201~");
		if (end === -1) return;
		const pasted = this.pasteBuffer.slice(0, end);
		const after = this.pasteBuffer.slice(end + 6);
		this.pasteActive = false;
		this.pasteBuffer = "";
		if (pasted) this.editor!.insertTextAtCursor(pasted);
		if (after) this.handleEditorInput(after);
	}

	private persistEditor(): void {
		this.flushPendingPaste();
		const editing = this.editing;
		const questionIndex = this.editorQuestionIndex;
		if (!this.editor || !editing || questionIndex === undefined) return;
		const value = this.editor.getExpandedText();
		this.storeEditorValue(editing, questionIndex, editing === "custom" ? value : value.trim());
	}

	private flushPendingPaste(): void {
		if (!this.editor || !this.pasteActive) return;
		const pending = this.pasteBuffer;
		this.pasteActive = false;
		this.pasteBuffer = "";
		if (pending) this.editor.insertTextAtCursor(pending);
	}

	private storeEditorValue(editing: Exclude<Editing, undefined>, index: number, value: string): void {
		this.state = reduceQuestionnairePresentation(this.state, editing === "custom"
			? { type: "set-custom-draft", questionIndex: index, value }
			: editing === "question-note" ? { type: "set-question-note", questionIndex: index, value }
				: { type: "set-global-note", value });
	}

	private rebuild(): void {
		if (this.disposed || this.rebuilding) return;
		this.pointerFocusRefreshPending = false;
		this.rebuilding = true;
		try {
			this.renderedWidth = undefined;
			this.renderedTerminalRows = undefined;
			this.renderedHeight = undefined;
			this.hoveredFooter = undefined;
			const focused = this.optionControl?.getFocusedOption();
			if (focused) this.optionFocus = { questionIndex: this.optionControlQuestionIndex ?? this.state.activeQuestionIndex, id: focused.id };
			this.pointerScope.invalidate();
			this.pointerScope.dispose();
			this.pointerScope = new NativePointerScope();
			this.retireOptionControl();
			super.clear();
			const { request, activeQuestionIndex: index } = this.state;
			this.keyboardFocus = this.normalizeKeyboardFocus(this.keyboardFocus);
			const question = request.questions[index]!;
			for (const [itemIndex, item] of request.questions.entries()) {
				this.addChild(this.clickable(`${itemIndex === index ? "●" : "○"} ${itemIndex + 1}. ${display(item.header)}`, () => this.focusQuestion(itemIndex)));
			}
			const prefix = this.localize("chrome.question.prefix", "Question {index}:").replaceAll("{index}", String(index + 1));
			this.addChild(new Text(this.presentationOptions.theme.bold(`${prefix} ${display(question.question)}`), 1, 0));
			const custom = this.localize("chrome.tab.custom", "Custom answer");
			this.optionControl = new QuestionOptionControl({
				items: question.options.map((option, optionIndex) => ({ id: String(optionIndex), ...option })),
				multiSelect: question.multiSelect,
				inlinePreview: question.multiSelect,
				selectedIds: question.multiSelect
					? question.options.flatMap((option, optionIndex) => this.state.multiSelections[index]!.includes(option.label) ? [String(optionIndex)] : [])
					: question.options.flatMap((option, optionIndex) => this.state.optionSelections[index] === option.label ? [String(optionIndex)] : []),
				focusedId: this.optionFocus?.questionIndex === index ? this.optionFocus.id : undefined,
				theme: optionTheme(this.presentationOptions.theme, () => this.keyboardFocus.type === "option"), keybindings: this.presentationOptions.keybindings, localize: this.presentationOptions.localize,
				onAction: (action) => this.handleOption(action), onCancel: () => this.finish({ type: "cancel" }),
			});
			this.optionControlQuestionIndex = index;
			if (question.multiSelect) this.addChild(this.optionControl);
			else {
				this.optionLayout = new QuestionOptionPreviewLayout({
					control: this.optionControl,
					hasPreview: question.options.some((option) => option.preview !== undefined),
					theme: this.presentationOptions.theme, localize: this.presentationOptions.localize,
				});
				this.addChild(this.optionLayout);
			}
			this.addChild(this.clickable(custom, () => this.setTab("custom"), undefined, { type: "custom" }));
			if (this.editing === "custom") {
				this.addChild(new Text(this.presentationOptions.theme.fg("muted", editorLabel(this.editing, this.localize.bind(this))), 1, 0));
				this.addChild(this.editor!);
			} else {
				const draft = this.state.customDrafts[index];
				if (draft !== undefined) this.addChild(new Text(this.presentationOptions.localize ? `${this.localize("chrome.custom.response", "Custom response:")} ${display(draft)}` : display(draft), 1, 0));
			}
			const questionNote = this.localize("chrome.note.question", "Question note");
			this.addChild(this.clickable(questionNote, () => this.openEditor("question-note"), undefined, { type: "question-note" }));
			if (this.editing === "question-note") {
				this.addChild(new Text(this.presentationOptions.theme.fg("muted", editorLabel(this.editing, this.localize.bind(this))), 1, 0));
				this.addChild(this.editor!);
			} else {
				const note = this.state.questionNotes[index];
				if (note !== undefined && note.length > 0) this.addChild(new Text(`${questionNote}: ${display(note)}`, 1, 0));
			}
			if (this.isFinalQuestion()) {
				const globalNote = this.localize("chrome.note.global", "Global note");
				this.addChild(this.clickable(globalNote, () => this.openEditor("global-note"), undefined, { type: "global-note" }));
				if (this.editing === "global-note") {
					this.addChild(new Text(this.presentationOptions.theme.fg("muted", editorLabel(this.editing, this.localize.bind(this))), 1, 0));
					this.addChild(this.editor!);
				} else {
					const note = this.state.globalNote;
					if (note !== undefined && note.length > 0) this.addChild(new Text(`${globalNote}: ${display(note)}`, 1, 0));
				}
			}
			const cancelHint = this.cancellationHint();
			if (!this.editing && cancelHint.length > 0) this.addChild(new Text(this.presentationOptions.theme.fg("dim", cancelHint), 1, 0));
			const primary = this.isFinalQuestion()
				? this.localize("chrome.primary.submit", "Submit") : this.localize("chrome.primary.next", "Next");
			const cancel = this.localize("chrome.cancel", "Cancel");
			const primaryButton = this.clickable(`[${primary}]`, () => this.activatePrimary(), "primary", { type: "primary" });
			const cancelButton = this.clickable(cancel, () => this.finish({ type: "cancel" }), "cancel", { type: "cancel" });
			this.addChild(new QuestionnaireFooterRow(primaryButton, cancelButton, visibleWidth(`[${primary}]`) + 2, visibleWidth(cancel) + 2));
		} finally {
			this.rebuilding = false;
		}
	}

	private handledMouseResult(event: TuiMouseEvent, render: boolean): Exclude<FullscreenMouseResult, undefined> {
		return {
			handled: true,
			render,
			target: {
				component: this,
				originX: event.screenX - event.x,
				originY: event.screenY - event.y,
				width: event.width,
				height: event.height,
			},
		};
	}

	private localize(key: string, fallback: string): string {
		try {
			const value = this.presentationOptions.localize?.(key, fallback);
			return typeof value === "string" && value.trim().length > 0 ? value : fallback;
		} catch {
			return fallback;
		}
	}

	private retireOptionControl(): void {
		this.optionLayout?.dispose();
		this.optionLayout = undefined;
		this.optionControl?.dispose();
		this.optionControl = undefined;
		this.optionControlQuestionIndex = undefined;
	}

	private clickable(
		text: string, action: () => void, footer?: "primary" | "cancel", keyboardTarget?: KeyboardFocusTarget,
	): Component {
		const focused = keyboardTarget !== undefined && this.sameKeyboardFocus(this.keyboardFocus, keyboardTarget);
		const box = new Box(0, 0, (value) => focused
			? this.presentationOptions.theme.bg("selectedBg", value)
			: footer !== undefined && this.hoveredFooter === footer
				? this.presentationOptions.theme.bg("selectedBg", value) : value);
		const prefix = focused ? this.presentationOptions.theme.fg("accent", "→ ") : "";
		box.addChild(new Text(`${prefix}${this.presentationOptions.theme.fg(focused ? "accent" : "dim", text)}`, 0, 0));
		return this.pointerScope.wrap(box, {
			onPress: (event) => {
				if (keyboardTarget === undefined || event.button !== "left") return undefined;
				this.keyboardFocus = keyboardTarget;
				this.pointerFocusRefreshPending = true;
				this.presentationOptions.tui.requestRender();
				return { handled: true, focus: true };
			},
			onHover: () => {
				if (footer === undefined || this.hoveredFooter === footer) return undefined;
				this.hoveredFooter = footer;
				return { handled: true, render: true };
			},
			onLeave: () => {
				if (footer === undefined || this.hoveredFooter !== footer) return;
				this.hoveredFooter = undefined;
			},
			onClick: (event) => {
				if (!this.disposed && !this.rebuilding && !this.finishing && event.button === "left") {
					if (keyboardTarget !== undefined) this.setKeyboardFocus(keyboardTarget);
					action();
				}
				return { handled: true, focus: true };
			},
		});
	}

	private handleOption(action: QuestionOptionControlAction): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		const index = this.state.activeQuestionIndex;
		if (action.type === "focus-option") this.followKeyboardFocus = false;
		this.keyboardFocus = { type: "option", id: action.option.id };
		this.optionFocus = { questionIndex: index, id: action.option.id };
		if (this.state.tabs[index] !== "options") {
			if (this.editing) this.closeEditor(false);
			this.state = reduceQuestionnairePresentation(this.state, { type: "set-tab", questionIndex: index, tab: "options" });
		}
		if (action.type === "focus-option") {
			// Refresh on the next render, after the pointer callback unwinds, so old regions remain valid.
			this.pointerFocusRefreshPending = true;
			return;
		}
		const label = action.option.label;
		if (this.state.tabs[index] !== "options") return;
		if (action.type === "select-option") this.dispatch({ type: "select-option", questionIndex: index, label });
		if (action.type === "toggle-option") this.dispatch({ type: "toggle-option", questionIndex: index, label });
	}
}

const SINGLE_SELECT_SIDE_PANEL_MIN_WIDTH = 64;
const SINGLE_SELECT_SIDE_PANEL_DIVIDER_WIDTH = 3;
const SINGLE_SELECT_SIDE_PANEL_MIN_PREVIEW_WIDTH = 24;
/** Leaves room for question navigation, tabs, option controls, and the sticky footer on short terminals. */
const PREVIEW_SLOT_CHROME_ROWS = 8;
const PREVIEW_SLOT_MAX_ROWS = 8;
const PREVIEW_SCROLL_HINT = "Ctrl+PgUp/PgDn";
const PREVIEW_SCROLL_HINT_COMPACT = "Ctrl Pg/Dn";
const PREVIEW_SCROLL_HINT_FULL_WIDTH = "Preview: ".length + PREVIEW_SCROLL_HINT.length;

function previewSlotRows(terminalRows: number): number {
	return Math.max(1, Math.min(PREVIEW_SLOT_MAX_ROWS, Math.floor(terminalRows) - PREVIEW_SLOT_CHROME_ROWS));
}

interface QuestionOptionPreviewLayoutOptions {
	readonly control: QuestionOptionControl;
	readonly hasPreview: boolean;
	readonly theme: QuestionnaireTuiPresentationTheme;
	readonly localize?: QuestionnaireLocalizer;
}

/** Keeps focused single-select previews separate from the option rows without changing multi-select output. */
class QuestionOptionPreviewLayout implements Component {
	private readonly control: QuestionOptionControl;
	private readonly hasPreview: boolean;
	private readonly theme: QuestionnaireTuiPresentationTheme;
	private readonly localize: QuestionnaireLocalizer | undefined;
	private previewValue: string | undefined;
	private markdown: Markdown | undefined;
	private renderedWidth: number | undefined;
	private previewViewportRows = PREVIEW_SLOT_MAX_ROWS;
	private previewScrollTop = 0;
	private previewVirtualHeight = 0;
	private sidePanel = false;
	private optionWidth = 0;
	private optionHeight = 0;
	private previewWidth = 0;
	private disposed = false;

	constructor(options: QuestionOptionPreviewLayoutOptions) {
		this.control = options.control;
		this.hasPreview = options.hasPreview;
		this.theme = options.theme;
		this.localize = options.localize;
	}

	render(width: number): string[] {
		if (this.disposed) return [];
		const bounded = Math.max(0, Math.floor(width));
		if (bounded === 0) return [];
		this.setPreview(this.control.getFocusedOption()?.preview);
		if (!this.hasPreview) {
			const options = this.control.render(bounded);
			this.renderedWidth = bounded;
			this.sidePanel = false;
			this.optionWidth = bounded;
			this.optionHeight = options.length;
			this.previewWidth = 0;
			this.previewVirtualHeight = 0;
			this.previewScrollTop = 0;
			return options;
		}
		if (bounded >= SINGLE_SELECT_SIDE_PANEL_MIN_WIDTH) {
			const { optionWidth, previewWidth } = sidePanelWidths(bounded);
			const options = this.control.render(optionWidth);
			this.renderedWidth = bounded;
			this.sidePanel = true;
			this.optionWidth = optionWidth;
			this.optionHeight = options.length;
			this.previewWidth = previewWidth;
			return columns(options, this.previewSlotLines(previewWidth), optionWidth, previewWidth, this.theme);
		}

		const options = this.control.render(bounded);
		this.renderedWidth = bounded;
		this.sidePanel = false;
		this.optionWidth = bounded;
		this.optionHeight = options.length;
		this.previewWidth = bounded;
		return [...options, "", ...this.previewSlotLines(bounded)];
	}

	handleMouse(event: TuiMouseEvent) {
		if (this.disposed || this.renderedWidth !== event.width) return undefined;
		if (event.type === "wheel") return this.handlePreviewWheel(event);
		if (this.sidePanel && (event.x < 0 || event.x >= this.optionWidth || event.y < 0 || event.y >= this.optionHeight)) return undefined;
		if ((!this.sidePanel && event.y < 0) || event.y >= this.optionHeight) return undefined;
		const width = this.sidePanel ? this.optionWidth : event.width;
		return this.control.handleMouse({ ...event, width, height: this.optionHeight });
	}

	createMouseObserver(requestRender: () => void): NativePointerMouseObserver {
		return this.control.createMouseObserver(requestRender);
	}

	dispose(): void {
		this.disposed = true;
		this.markdown = undefined;
	}

	invalidate(): void {
		this.renderedWidth = undefined;
		this.optionWidth = 0;
		this.optionHeight = 0;
		this.previewWidth = 0;
		this.previewVirtualHeight = 0;
		this.control.invalidate();
		if (this.previewValue !== undefined) this.markdown = new Markdown(display(this.previewValue), 0, 0, getMarkdownTheme());
		this.markdown?.invalidate();
	}

	setPreviewViewportRows(terminalRows: number): void {
		const next = previewSlotRows(terminalRows);
		if (next === this.previewViewportRows) return;
		this.previewViewportRows = next;
		const maximum = Math.max(0, this.previewVirtualHeight - next);
		this.previewScrollTop = Math.max(0, Math.min(maximum, this.previewScrollTop));
	}

	scrollPreviewPage(direction: -1 | 1): boolean {
		return this.scrollPreviewBy(direction * Math.max(1, this.previewViewportRows - 1));
	}

	private setPreview(preview: string | undefined): void {
		if (preview === this.previewValue) return;
		this.previewValue = preview;
		this.markdown = preview === undefined ? undefined : new Markdown(display(preview), 0, 0, getMarkdownTheme());
		this.previewScrollTop = 0;
		this.previewVirtualHeight = 0;
	}

	private previewSlotLines(width: number): string[] {
		if (this.previewValue === undefined) {
			this.previewVirtualHeight = 0;
			this.previewScrollTop = 0;
			return Array(this.previewViewportRows).fill("");
		}
		const content = this.previewLines(width);
		const virtual = content.length > this.previewViewportRows ? this.previewLines(width, true) : content;
		this.previewVirtualHeight = virtual.length;
		const maximum = Math.max(0, virtual.length - this.previewViewportRows);
		this.previewScrollTop = Math.max(0, Math.min(maximum, this.previewScrollTop));
		const visible = virtual.slice(this.previewScrollTop, this.previewScrollTop + this.previewViewportRows);
		return [...visible, ...Array(Math.max(0, this.previewViewportRows - visible.length)).fill("")];
	}

	private handlePreviewWheel(event: TuiMouseEvent) {
		if (!event.wheelDelta || !this.isPreviewCoordinate(event)) return undefined;
		return this.scrollPreviewBy(event.wheelDelta < 0 ? -1 : 1) ? { handled: true, render: true } : undefined;
	}

	private scrollPreviewBy(delta: number): boolean {
		if (this.previewValue === undefined || this.previewVirtualHeight <= this.previewViewportRows) return false;
		const maximum = this.previewVirtualHeight - this.previewViewportRows;
		const next = Math.max(0, Math.min(maximum, this.previewScrollTop + delta));
		if (next === this.previewScrollTop) return false;
		this.previewScrollTop = next;
		return true;
	}

	private isPreviewCoordinate(event: TuiMouseEvent): boolean {
		if (event.x < 0 || event.x >= event.width || event.y < 0 || event.y >= event.height) return false;
		if (this.sidePanel) {
			const previewStart = this.optionWidth + SINGLE_SELECT_SIDE_PANEL_DIVIDER_WIDTH;
			return event.x >= previewStart && event.x < previewStart + this.previewWidth && event.y < this.previewViewportRows;
		}
		const previewStart = this.optionHeight + 1;
		return event.y >= previewStart && event.y < previewStart + this.previewViewportRows;
	}

	private previewLines(width: number, showScrollHint = false): string[] {
		const lines = (this.markdown?.render(width) ?? []).map((line) => truncateToWidth(line, width, ""));
		const rendered = lines.length === 0 ? [""] : lines;
		const caption = this.localizeText("chrome.preview.caption", "Preview:");
		const localizedHint = this.localizeText("chrome.preview.scrollHint", PREVIEW_SCROLL_HINT);
		const hintText = localizedHint === PREVIEW_SCROLL_HINT && width < PREVIEW_SCROLL_HINT_FULL_WIDTH ? PREVIEW_SCROLL_HINT_COMPACT : localizedHint;
		const hint = showScrollHint ? ` ${hintText}` : "";
		return [truncateToWidth(`${caption}${hint}`, width, ""), ...rendered];
	}

	private localizeText(key: string, fallback: string): string {
		try {
			const value = this.localize?.(key, fallback);
			return typeof value === "string" && value.trim().length > 0 ? value : fallback;
		} catch {
			return fallback;
		}
	}
}

function sidePanelWidths(width: number): { optionWidth: number; previewWidth: number } {
	const previewWidth = Math.max(SINGLE_SELECT_SIDE_PANEL_MIN_PREVIEW_WIDTH, Math.floor(width * 0.38));
	return {
		optionWidth: Math.max(1, width - SINGLE_SELECT_SIDE_PANEL_DIVIDER_WIDTH - previewWidth),
		previewWidth,
	};
}

function columns(
	options: readonly string[], preview: readonly string[], optionWidth: number, previewWidth: number,
	theme: QuestionnaireTuiPresentationTheme,
): string[] {
	const divider = theme.fg("dim", " │ ");
	const height = Math.max(options.length, preview.length);
	return Array.from({ length: height }, (_, index) => {
		const left = padToWidth(options[index] ?? "", optionWidth);
		const right = truncateToWidth(preview[index] ?? "", previewWidth, "");
		return `${left}${divider}${right}`;
	});
}

function padToWidth(value: string, width: number): string {
	const truncated = truncateToWidth(value, width, "");
	return truncated + " ".repeat(Math.max(0, width - visibleWidth(truncated)));
}

const COLLAPSE_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const COLLAPSE_NAMED_KEYS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete", "insert", "clear", "home", "end",
	"pageup", "pagedown", "up", "down", "left", "right", ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
]);
const COLLAPSE_PRINTABLE_KEY = /^[a-z0-9_\-!@#$%^&*()|~`'":;,./<>?[\]{}=\\]$/;
const COLLAPSE_BASE_ALIASES: Record<string, string> = { esc: "escape", return: "enter" };

function normalizeCollapseKey(value: string | undefined): string | undefined {
	if (value === undefined) return undefined;
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

function matchingKeyId(keyId: string | undefined): string | undefined {
	const normalized = normalizeCollapseKey(keyId);
	if (normalized === undefined || normalized === "off") return undefined;
	const parts = normalized.split("+");
	const base = COLLAPSE_BASE_ALIASES[parts.at(-1)!] ?? parts.at(-1)!;
	const modifiers = new Set(parts.slice(0, -1));
	return [...["shift", "ctrl", "alt", "super"].filter((modifier) => modifiers.has(modifier)), base].join("+");
}

function formatCollapseKey(keyId: string | undefined): string {
	if (keyId === undefined) return "";
	const display: Record<string, string> = { escape: "Esc", esc: "Esc", pageup: "PageUp", pagedown: "PageDown" };
	return keyId.split("+").map((part) => {
		const normalized = part.toLowerCase();
		return display[normalized] ?? (part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1));
	}).join("+");
}

function editorTheme(theme: QuestionnaireTuiPresentationTheme) {
	return {
		borderColor: (text: string) => theme.fg("accent", text),
		selectList: { selectedPrefix: (text: string) => theme.fg("accent", text), selectedText: (text: string) => theme.fg("accent", text), description: (text: string) => theme.fg("muted", text), scrollInfo: (text: string) => theme.fg("dim", text), noMatch: (text: string) => theme.fg("warning", text) },
	};
}

function optionTheme(theme: QuestionnaireTuiPresentationTheme, keyboardActive: () => boolean) {
	return {
		selectedPrefix: (text: string) => keyboardActive() ? theme.fg("accent", text) : "  ",
		selectedText: (text: string) => keyboardActive() ? theme.fg("accent", text) : text,
		description: (text: string) => theme.fg("muted", text), preview: (text: string) => theme.fg("dim", text),
		hoverBackground: (text: string) => theme.bg("selectedBg", text),
		focusBackground: (text: string) => keyboardActive() ? theme.bg("selectedBg", text) : text,
	};
}

class QuestionnaireFooterRow implements Component {
	private readonly primary: Component;
	private readonly cancel: Component;
	private readonly primaryPreferred: number;
	private readonly cancelPreferred: number;
	private lastWidth: number | undefined;
	private primaryWidth = 0;
	private cancelWidth = 0;

	constructor(primary: Component, cancel: Component, primaryPreferred: number, cancelPreferred: number) {
		this.primary = primary;
		this.cancel = cancel;
		this.primaryPreferred = primaryPreferred;
		this.cancelPreferred = cancelPreferred;
	}

	render(width: number): string[] {
		const bounded = Math.max(0, Math.floor(width));
		this.lastWidth = bounded;
		if (bounded === 0) return [];
		this.primaryWidth = Math.min(this.primaryPreferred, bounded);
		this.cancelWidth = Math.min(this.cancelPreferred, bounded);
		return [
			this.primary.render(this.primaryWidth)[0] ?? "",
			this.cancel.render(this.cancelWidth)[0] ?? "",
		];
	}

	handleMouse(event: TuiMouseEvent) {
		const width = Math.max(0, Math.floor(event.width));
		if (this.lastWidth !== width || event.x < 0 || event.x >= width || event.y < 0 || event.y >= 2) return undefined;
		const targetWidth = event.y === 0 ? this.primaryWidth : this.cancelWidth;
		if (event.x >= targetWidth || targetWidth === 0) return { handled: true };
		const target = event.y === 0 ? this.primary : this.cancel;
		return target.handleMouse?.({ ...event, y: 0, width: targetWidth }) ?? { handled: true };
	}

	invalidate(): void {
		this.lastWidth = undefined;
		this.primaryWidth = 0;
		this.cancelWidth = 0;
		this.primary.invalidate();
		this.cancel.invalidate();
	}
}

function editorLabel(editing: Exclude<Editing, undefined>, localize: QuestionnaireLocalizer): string {
	return editing === "custom" ? localize("chrome.editor.custom", "Custom response (Esc keeps draft)")
		: editing === "question-note" ? "Question note (Esc keeps draft)" : "Global note (Esc keeps draft)";
}

const C1_STRING = /[\u0090\u0098\u009d\u009e\u009f][^\u0007\u009c]*(?:[\u0007\u009c]|$)/g;
const C1_CSI = /\u009b[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
function display(value: string): string {
	return stripTerminalSequences(value).replace(C1_STRING, "").replace(C1_CSI, "").replace(UNSAFE_CONTROL, "");
}
