import {
	Box,
	CURSOR_MARKER,
	Editor,
	isKeyRelease,
	matchesKey,
	Text,
	truncateToWidth,
	type Component,
	type Focusable,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
	stripTerminalSequences,
} from "@earendil-works/pi-tui";
import { NativeFullscreenInteraction } from "../native-fullscreen-interaction.ts";
import { NativePointerScope } from "../native-pointer-region.ts";
import type { FrozenQuestionnaireRequest, RawQuestionnaireOutcome } from "./contract.ts";
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
	readonly onDone: (outcome: RawQuestionnaireOutcome) => void;
}

type Editing = "custom" | "question-note" | "global-note" | undefined;

/** Fullscreen presentation only; its driver adapter remains deliberately separate. */
export class QuestionnaireTuiPresentation extends NativeFullscreenInteraction implements Focusable {
	private readonly presentationOptions: QuestionnaireTuiPresentationOptions;
	private state: QuestionnairePresentationState;
	private pointerScope = new NativePointerScope();
	private optionControl: QuestionOptionControl | undefined;
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
	private hoveredFooter: "primary" | "cancel" | undefined;
	private rebuilding = false;
	private finishing = false;
	private disposed = false;
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
		this.state = createQuestionnairePresentationState(options.request);
		this.rebuild();
	}

	override handleInput(data: string): void {
		if (!this.disposed) super.handleInput(data);
	}

	override handleMouse(event: TuiMouseEvent): FullscreenMouseResult {
		if (this.disposed || this.renderedWidth === undefined || this.renderedTerminalRows === undefined || this.renderedHeight === undefined ||
			Math.max(0, Math.floor(this.presentationOptions.tui.terminal.rows)) !== this.renderedTerminalRows ||
			event.width !== this.renderedWidth || event.height !== this.renderedHeight) return undefined;
		if (event.type === "wheel") {
			if (event.y >= this.bodyVisibleHeight || !event.wheelDelta) return undefined;
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
		const controls = Math.min(this.renderedHeight, 2);
		const footerY = event.y - this.bodyVisibleHeight;
		const documentY = event.y < this.bodyVisibleHeight
			? this.bodyScrollTop + event.y
			: this.documentHeight - controls + footerY;
		if (documentY < 0 || documentY >= this.documentHeight) return undefined;
		return super.handleMouse({ ...event, y: documentY, height: this.documentHeight });
	}

	override render(width: number): string[] {
		if (this.disposed) return [];
		const bounded = Math.max(0, Math.floor(width));
		const terminalRows = Math.max(0, Math.floor(this.presentationOptions.tui.terminal.rows));
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
		this.bodyVirtualHeight = this.footerStart + 1;
		const height = Math.min(terminalRows, this.bodyVirtualHeight + 2);
		const controls = Math.min(height, 2);
		this.bodyVisibleHeight = height - controls;
		const maximum = Math.max(0, this.bodyVirtualHeight - this.bodyVisibleHeight);
		this.bodyScrollTop = Math.max(0, Math.min(maximum, this.bodyScrollTop));
		const markerLine = document.findIndex((line) => line.includes(CURSOR_MARKER));
		if (this.followEditorCursor && markerLine >= 0 && markerLine < this.footerStart && this.bodyVisibleHeight > 0) {
			const lastVisible = this.bodyScrollTop + this.bodyVisibleHeight - 1;
			if (markerLine < this.bodyScrollTop) this.bodyScrollTop = markerLine;
			else if (markerLine > lastVisible) this.bodyScrollTop = markerLine - this.bodyVisibleHeight + 1;
			this.bodyScrollTop = Math.max(0, Math.min(maximum, this.bodyScrollTop));
		}
		const body = document.slice(this.bodyScrollTop, Math.min(this.footerStart, this.bodyScrollTop + this.bodyVisibleHeight));
		this.bodyContentHeight = body.length;
		const footer = document.slice(document.length - controls);
		const lines = [...body, ...Array(Math.max(0, this.bodyVisibleHeight - body.length)).fill(""), ...footer];
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

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.renderedWidth = undefined;
		this.renderedTerminalRows = undefined;
		this.renderedHeight = undefined;
		this.pasteActive = false;
		this.pasteBuffer = "";
		if (this.editor) this.editor.onChange = undefined;
		this.editor = undefined;
		this.editorQuestionIndex = undefined;
		this.retireOptionControl();
		this.pointerScope.dispose();
		super.clear();
	}

	private routeInput(data: string): void {
		if (this.disposed || isKeyRelease(data)) return;
		if (this.editing) {
			if (this.pasteActive || data.includes("\u001b[200~")) this.handleEditorInput(data);
			else if (matchesKey(data, "escape")) this.closeEditor();
			else if (matchesKey(data, "enter")) this.editor!.insertTextAtCursor("\n");
			else this.handleEditorInput(data);
			return;
		}
		if (matchesKey(data, "tab")) return this.setTab(this.state.tabs[this.state.activeQuestionIndex] === "options" ? "custom" : "options");
		if (matchesKey(data, "escape")) return this.finish({ type: "cancel" });
		if (data === "[") return this.focusQuestion(this.state.activeQuestionIndex - 1);
		if (data === "]") return this.focusQuestion(this.state.activeQuestionIndex + 1);
		if (data === "n") return this.activatePrimary();
		if (data === "s") return this.submitCurrent();
		this.optionControl?.handleInput(data);
	}

	private observeMouse(method: "beforeMouse" | "afterMouse", event: TuiMouseEvent): void {
		this.pointerScope.createMouseObserver(() => this.presentationOptions.tui.requestRender())[method](event);
		this.optionControl?.createMouseObserver(() => this.presentationOptions.tui.requestRender())[method](event);
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

	private focusQuestion(index: number): void {
		if (index < 0 || index >= this.state.request.questions.length || index === this.state.activeQuestionIndex) return;
		this.closeEditor();
		this.dispatch({ type: "focus-question", questionIndex: index });
	}

	private setTab(tab: "options" | "custom"): void {
		if (tab === "options" && this.editing === "custom") this.closeEditor(false);
		this.dispatch({ type: "set-tab", questionIndex: this.state.activeQuestionIndex, tab });
		if (tab === "custom") this.openEditor("custom");
	}

	private activatePrimary(): void {
		if (this.state.activeQuestionIndex === this.state.request.questions.length - 1) return this.submitCurrent();
		this.continueToNextQuestion();
	}

	private continueToNextQuestion(): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		this.persistEditor();
		if (!this.hasExplicitActiveAnswer()) return;
		const index = this.state.activeQuestionIndex;
		const committed = reduceQuestionnairePresentation(this.state, { type: "next" });
		if (committed === this.state) return;
		this.state = committed;
		this.closeEditor(false);
		this.state = reduceQuestionnairePresentation(this.state, { type: "focus-question", questionIndex: index + 1 });
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
		if (this.state.tabs[index] === "custom") return true;
		const question = this.state.request.questions[index]!;
		return question.multiSelect ? this.state.multiSelections[index]!.length > 0 : this.state.optionSelections[index] !== undefined;
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
		if (this.editor && this.editing && this.editorQuestionIndex !== undefined) {
			this.storeEditorValue(this.editing, this.editorQuestionIndex, this.editor.getExpandedText());
		}
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
		this.rebuilding = true;
		try {
			this.renderedWidth = undefined;
			this.renderedTerminalRows = undefined;
			this.renderedHeight = undefined;
			this.hoveredFooter = undefined;
			const focused = this.optionControl?.getFocusedOption();
			if (focused) this.optionFocus = { questionIndex: this.state.activeQuestionIndex, id: focused.id };
			this.pointerScope.invalidate();
			this.pointerScope.dispose();
			this.pointerScope = new NativePointerScope();
			this.retireOptionControl();
			super.clear();
			const { request, activeQuestionIndex: index } = this.state;
			const question = request.questions[index]!;
		for (const [itemIndex, item] of request.questions.entries()) {
			this.addChild(this.clickable(`${itemIndex === index ? "●" : "○"} ${itemIndex + 1}. ${display(item.header)}`, () => this.focusQuestion(itemIndex)));
		}
		this.addChild(new Text(this.presentationOptions.theme.bold(`Question ${index + 1}: ${display(question.question)}`), 1, 0));
		const optionTab = this.state.tabs[index] === "options" ? "[Options]" : "Options";
		const customTab = this.state.tabs[index] === "custom" ? "[Custom answer]" : "Custom answer";
		this.addChild(this.clickable(optionTab, () => this.setTab("options")));
		this.addChild(this.clickable(customTab, () => this.setTab("custom")));
		if (this.editing) {
			this.addChild(new Text(this.presentationOptions.theme.fg("muted", editorLabel(this.editing)), 1, 0));
			this.addChild(this.editor!);
		} else if (this.state.tabs[index] === "custom") {
			this.addChild(new Text(this.presentationOptions.theme.fg("muted", `Custom response: ${display(this.state.customDrafts[index] ?? "")}`), 1, 0));
		} else {
			this.optionControl = new QuestionOptionControl({
				items: question.options.map((option, optionIndex) => ({ id: String(optionIndex), ...option })),
				multiSelect: question.multiSelect,
				selectedIds: question.multiSelect
					? question.options.flatMap((option, optionIndex) => this.state.multiSelections[index]!.includes(option.label) ? [String(optionIndex)] : [])
					: question.options.flatMap((option, optionIndex) => this.state.optionSelections[index] === option.label ? [String(optionIndex)] : []),
				focusedId: this.optionFocus?.questionIndex === index ? this.optionFocus.id : undefined,
				theme: optionTheme(this.presentationOptions.theme), keybindings: this.presentationOptions.keybindings,
				onAction: (action) => this.handleOption(action), onCancel: () => this.finish({ type: "cancel" }),
			});
			this.addChild(this.optionControl);
		}
		const primary = index === request.questions.length - 1 ? "Submit" : "Next";
		this.addChild(this.clickable(primary, () => this.activatePrimary(), "primary"));
		this.addChild(this.clickable("Cancel", () => this.finish({ type: "cancel" }), "cancel"));
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

	private retireOptionControl(): void {
		this.optionControl?.dispose();
		this.optionControl = undefined;
	}

	private clickable(text: string, action: () => void, footer?: "primary" | "cancel"): Component {
		const box = new Box(0, 0, (value) => footer !== undefined && this.hoveredFooter === footer
			? this.presentationOptions.theme.bg("selectedBg", value) : value);
		box.addChild(new Text(this.presentationOptions.theme.fg("dim", text), 1, 0));
		return this.pointerScope.wrap(box, {
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
				if (!this.disposed && !this.rebuilding && !this.finishing && event.button === "left") action();
				return { handled: true, focus: true };
			},
		});
	}

	private handleOption(action: QuestionOptionControlAction): void {
		if (this.disposed || this.rebuilding || this.finishing) return;
		this.optionFocus = { questionIndex: this.state.activeQuestionIndex, id: action.option.id };
		const label = action.option.label;
		if (action.type === "select-option") this.dispatch({ type: "select-option", questionIndex: this.state.activeQuestionIndex, label });
		if (action.type === "toggle-option") this.dispatch({ type: "toggle-option", questionIndex: this.state.activeQuestionIndex, label });
	}
}

function editorTheme(theme: QuestionnaireTuiPresentationTheme) {
	return {
		borderColor: (text: string) => theme.fg("accent", text),
		selectList: { selectedPrefix: (text: string) => theme.fg("accent", text), selectedText: (text: string) => theme.fg("accent", text), description: (text: string) => theme.fg("muted", text), scrollInfo: (text: string) => theme.fg("dim", text), noMatch: (text: string) => theme.fg("warning", text) },
	};
}

function optionTheme(theme: QuestionnaireTuiPresentationTheme) {
	return {
		selectedPrefix: (text: string) => theme.fg("accent", text), selectedText: (text: string) => theme.fg("accent", text), description: (text: string) => theme.fg("muted", text), preview: (text: string) => theme.fg("dim", text), hoverBackground: (text: string) => theme.bg("selectedBg", text),
	};
}

function editorLabel(editing: Exclude<Editing, undefined>): string {
	return editing === "custom" ? "Custom response (Esc keeps draft)" : editing === "question-note" ? "Question note (Esc keeps draft)" : "Global note (Esc keeps draft)";
}

const C1_STRING = /[\u0090\u0098\u009d\u009e\u009f][^\u0007\u009c]*(?:[\u0007\u009c]|$)/g;
const C1_CSI = /\u009b[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
function display(value: string): string {
	return stripTerminalSequences(value).replace(C1_STRING, "").replace(C1_CSI, "").replace(UNSAFE_CONTROL, "");
}
