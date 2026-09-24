import {
	Container,
	Editor,
	isKeyRelease,
	matchesKey,
	Text,
	visibleWidth,
	type EditorTheme,
	type Focusable,
	type KeybindingsManager,
	type TUI,
	type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import { CUSTOM_ROW_LABEL, type QuestionData } from "./schema.ts";

/** Minimum terminal width at which the preview pane splits beside the list. */
export const MIN_PREVIEW_WIDTH = 80;

/** Fraction of the width given to the option column when a preview pane is shown. */
const PREVIEW_SPLIT = 0.45;

/** Two-space gutter between the option column and the preview pane. No divider frame. */
const PREVIEW_GAP = "  ";

/** Theme surface used by the questionnaire, compatible with the Pi TUI theme. */
export interface QuestionnaireTheme {
	fg(color: string, text: string): string;
	bg?(color: string, text: string): string;
	bold?(text: string): string;
}

/** One committed answer for a question. */
export interface AnswerRow {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	preview?: string;
}

/** Final questionnaire outcome handed to the caller. */
export interface QuestionnaireResult {
	cancelled: boolean;
	answers: AnswerRow[];
}

/** Construction options for {@link QuestionnaireView}. */
export interface QuestionnaireViewOptions {
	questions: QuestionData[];
	theme: QuestionnaireTheme;
	tui: TUI;
	keybindings?: KeybindingsManager;
	onComplete?: (result: QuestionnaireResult) => void;
}

interface QuestionState {
	cursor: number;
	toggled: Set<number>;
	answer: AnswerRow | undefined;
	actionFocused: boolean;
}

type LineOwner =
	| { questionIndex: number; rowIndex: number }
	| { editorRow: number; editorHeight: number }
	| { action: "advance" | "cancel"; width: number };

/**
 * One-question-at-a-time questionnaire.
 *
 * The whole questionnaire is represented as a compact tab strip: exactly one
 * question body is rendered at a time, and Tab/Shift-Tab switches the active
 * question while each question keeps its own cursor, toggles, and custom-text
 * draft. This keeps the component's height bounded for one to four questions
 * so it fits the native dock area instead of overflowing the viewport.
 *
 * Native dock-swap component: it is a {@link Container}, never an overlay, so
 * the transcript stays scrollable while it is focused. Keyboard handling uses
 * the public Pi TUI input protocol (`matchesKey()` and the injected
 * `KeybindingsManager`), matching how the shipped agent views read input.
 */
export class QuestionnaireView extends Container implements Focusable {
	private readonly questions: QuestionData[];
	private readonly theme: QuestionnaireTheme;
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onComplete: ((result: QuestionnaireResult) => void) | undefined;
	private readonly states: QuestionState[];
	private readonly editors: Editor[];
	private pasting = false;
	private focusedQuestion = 0;
	private editingQuestion: number | undefined;
	private completed = false;
	private result: QuestionnaireResult | undefined;
	private lineOwners: Array<LineOwner | undefined> = [];
	private _focused = false;

	constructor(options: QuestionnaireViewOptions) {
		super();
		this.questions = options.questions;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onComplete = options.onComplete;
		this.states = options.questions.map(() => ({
			cursor: 0,
			toggled: new Set<number>(),
			answer: undefined,
			actionFocused: false,
		}));
		// An optional MULTI can be submitted without choosing an option.
		for (const [index, question] of options.questions.entries()) {
			if (question.multiSelect) this.states[index]!.actionFocused = true;
		}
		const editorTheme: EditorTheme = {
			borderColor: (text) => options.theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => options.theme.fg("accent", text),
				selectedText: (text) => options.theme.fg("accent", text),
				description: (text) => options.theme.fg("muted", text),
				scrollInfo: (text) => options.theme.fg("dim", text),
				noMatch: (text) => options.theme.fg("warning", text),
			},
		};
		// Retain each public Editor: text, caret and paste markers stay together.
		this.editors = options.questions.map(() => {
			const editor = new Editor(options.tui, editorTheme);
			editor.disableSubmit = true; // Commit raw expanded text before Editor trims/clears onSubmit.
			return editor;
		});
	}

	/** Focusable: propagate focus so the free-text editor gets the IME cursor. */
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.syncEditorFocus();
		this.invalidate();
	}

	/** Current committed result. Safe to call before completion. */
	getResult(): QuestionnaireResult {
		return this.result ?? { cancelled: false, answers: this.collectedAnswers() };
	}

	/** Active question index; exposed for tests and for callers that drive the view. */
	get activeQuestion(): number {
		return this.focusedQuestion;
	}

	handleInput(data: string): void {
		if (this.completed || isKeyRelease(data)) return;

		if (this.editingQuestion !== undefined) {
			const editor = this.editors[this.editingQuestion]!;
			// A bracketed paste may arrive in chunks containing literal Tab/Esc.
			if (this.pasting || data.includes("\x1b[200~")) {
				this.pasting = !data.includes("\x1b[201~");
				editor.handleInput(data);
				this.invalidate();
				return;
			}
			// Newline owns its binding even if it collides with the submit binding.
			if (this.matchesNewline(data)) {
				editor.insertTextAtCursor("\n");
				this.invalidate();
				return;
			}
			if (this.matchesTab(data, false) || this.matchesTab(data, true)) {
				const delta = this.matchesTab(data, true) ? -1 : 1;
				this.closeEditor();
				this.moveFocus(delta);
				return;
			}
			if (this.matches(data, "tui.select.cancel")) {
				this.closeEditor();
				return;
			}
			if (this.matchesSubmit(data)) {
				this.submitCustom(editor.getExpandedText());
				return;
			}
			editor.handleInput(data);
			this.invalidate();
			return;
		}

		if (this.matches(data, "tui.select.cancel")) {
			this.finish({ cancelled: true, answers: this.collectedAnswers() });
			return;
		}

		if (this.matchesTab(data, false)) {
			this.moveFocus(1);
			return;
		}

		if (this.matchesTab(data, true)) {
			this.moveFocus(-1);
			return;
		}

		if (this.matches(data, "tui.select.up")) {
			this.moveCursor(-1);
			return;
		}

		if (this.matches(data, "tui.select.down")) {
			this.moveCursor(1);
			return;
		}

		if (matchesKey(data, "space")) {
			const question = this.questions[this.focusedQuestion];
			if (question?.multiSelect) {
				this.toggleCursor();
				return;
			}
		}

		if (this.matches(data, "tui.select.confirm")) {
			if (this.states[this.focusedQuestion]?.actionFocused) this.advance();
			else this.commit();
		}
	}

	override handleMouse(event: TuiMouseEvent): ReturnType<Container["handleMouse"]> {
		if (this.completed) return undefined;
		const owner = this.lineOwners[event.y];
		if (!owner) return undefined;
		if ("editorRow" in owner) {
			if (this.editingQuestion === undefined) return undefined;
			const result = this.editors[this.editingQuestion]!.handleMouse({
				...event,
				y: owner.editorRow,
				height: owner.editorHeight,
			});
			if (!result || (!result.handled && !result.capture && !result.focus)) return undefined;
			return { ...result, handled: true, target: this.mouseTarget(event) };
		}
		if (this.editingQuestion !== undefined || event.button !== "left") return undefined;
		if ("action" in owner) {
			if (event.x < 0 || event.x >= owner.width) return undefined;
			if (event.type === "press") {
				return { handled: true as const, focus: true, render: false, target: this.mouseTarget(event) };
			}
			if (event.type === "click") {
				if (owner.action === "cancel") this.finish({ cancelled: true, answers: this.collectedAnswers() });
				else this.advance();
				return { handled: true as const, render: true, target: this.mouseTarget(event) };
			}
			return undefined;
		}
		if (owner.rowIndex < 0) return undefined;

		if (event.type === "press") {
			const changed = this.focusRow(owner.questionIndex, owner.rowIndex);
			return { handled: true as const, focus: true, render: changed, target: this.mouseTarget(event) };
		}

		if (event.type === "click") {
			const question = this.questions[owner.questionIndex];
			this.focusRow(owner.questionIndex, owner.rowIndex);
			// A multiSelect option toggles in place; only single-select (or the
			// custom row, which opens the editor) commits on click.
			if (question?.multiSelect && owner.rowIndex < question.options.length) {
				this.toggleCursor();
			}
			else {
				this.commit();
			}
			return { handled: true as const, render: true, target: this.mouseTarget(event) };
		}

		return undefined;
	}

	override render(width: number): string[] {
		const viewport = Math.max(1, width);
		const lines: string[] = [];
		const owners: Array<LineOwner | undefined> = [];
		const push = (text: string, owner?: LineOwner) => {
			for (const line of this.wrap(text, viewport)) {
				lines.push(line);
				owners.push(owner);
			}
		};

		if (this.questions.length === 0) {
			this.lineOwners = [];
			return [];
		}

		push(this.renderTabs());
		push("");

		const preview = this.currentPreview();
		if (preview !== undefined && viewport >= MIN_PREVIEW_WIDTH) {
			const leftWidth = Math.max(1, Math.floor(viewport * PREVIEW_SPLIT));
			const rightWidth = Math.max(1, viewport - leftWidth - PREVIEW_GAP.length);
			const left = this.renderBody(leftWidth, false);
			const right = this.wrap(this.theme.fg("dim", preview), rightWidth);
			const rows = Math.max(left.lines.length, right.length);
			for (let index = 0; index < rows; index++) {
				lines.push(`${padTo(left.lines[index] ?? "", leftWidth)}${PREVIEW_GAP}${right[index] ?? ""}`);
				owners.push(left.owners[index]);
			}
		}
		else {
			const body = this.renderBody(viewport, preview !== undefined);
			lines.push(...body.lines);
			owners.push(...body.owners);
		}

		push("");
		if (this.editingQuestion === undefined) {
			const action = this.focusedQuestion === this.questions.length - 1 ? "Submit" : "Next";
			for (const [label, kind] of [[action, "advance"], ["Cancel", "cancel"]] as const) {
				const styled = kind === "advance" && this.states[this.focusedQuestion]?.actionFocused
					? this.accent(label) : this.theme.fg("muted", label);
				let remaining = visibleWidth(label);
				for (const line of this.wrap(styled, viewport)) {
					lines.push(line);
					const hitWidth = Math.min(visibleWidth(line), remaining);
					owners.push({ action: kind, width: hitWidth });
					remaining -= hitWidth;
				}
			}
		}
		push(this.hint());

		this.lineOwners = owners;
		return lines;
	}

	override invalidate(): void {
		this.lineOwners = [];
		super.invalidate();
		this.syncEditorFocus();
	}

	/** Compact tab strip: every question is a chip, exactly one is active. */
	private renderTabs(): string {
		const total = this.questions.length;
		const progress = this.theme.fg("dim", `[${this.focusedQuestion + 1}/${total}]`);
		const chips = this.questions.map((question, index) => {
			const answered = this.states[index]?.answer !== undefined;
			const label = `${answered ? "✓ " : ""}${question.header}`;
			return index === this.focusedQuestion
				? this.accent(`▸ ${label}`)
				: this.theme.fg("muted", `  ${label}`);
		});
		return `${progress}  ${chips.join("   ")}`;
	}

	/** Body for the active question only. */
	private renderBody(width: number, inlinePreview: boolean): { lines: string[]; owners: Array<LineOwner | undefined> } {
		const lines: string[] = [];
		const owners: Array<LineOwner | undefined> = [];
		const push = (text: string, owner?: LineOwner) => {
			for (const line of this.wrap(text, width)) {
				lines.push(line);
				owners.push(owner);
			}
		};

		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return { lines, owners };

		const headerOwner: LineOwner = { questionIndex: this.focusedQuestion, rowIndex: -1 };
		push(this.accent(question.question), headerOwner);

		if (this.editingQuestion === this.focusedQuestion) {
			push("Custom response", headerOwner);
			push("> ", headerOwner);
			const editorLines = this.editors[this.focusedQuestion]!.render(width);
			for (const [editorRow, line] of editorLines.entries()) {
				lines.push(line);
				owners.push({ editorRow, editorHeight: editorLines.length });
			}
			push("Enter to submit • Esc to return to choices", headerOwner);
			return { lines, owners };
		}

		const customIndex = question.options.length;
		for (const [optionIndex, option] of question.options.entries()) {
			const owner: LineOwner = { questionIndex: this.focusedQuestion, rowIndex: optionIndex };
			const cursor = state.cursor === optionIndex ? this.accent("❯ ") : "  ";
			const marker = question.multiSelect ? `${state.toggled.has(optionIndex) ? "[x]" : "[ ]"} ` : "";
			push(`${cursor}${marker}${option.label}`, owner);
			push(`    ${this.theme.fg("dim", option.description)}`, owner);
			if (inlinePreview && state.cursor === optionIndex && option.preview !== undefined) {
				for (const line of this.wrap(this.theme.fg("dim", option.preview), Math.max(1, width - 4))) {
					push(`    ${line}`, owner);
				}
			}
		}

		const customOwner: LineOwner = { questionIndex: this.focusedQuestion, rowIndex: customIndex };
		const customCursor = state.cursor === customIndex ? this.accent("❯ ") : "  ";
		const customDone = state.answer?.kind === "custom" ? "✓ " : "";
		push(`${customCursor}${customDone}${CUSTOM_ROW_LABEL}`, customOwner);

		return { lines, owners };
	}

	/** Bottom hint for the active question's interaction model. */
	private hint(): string {
		const question = this.questions[this.focusedQuestion];
		const parts = ["↑↓ move"];
		if (question?.multiSelect) parts.push("space toggle");
		parts.push("enter select / action", "tab switch", "esc cancel");
		return this.theme.fg("dim", parts.join(" · "));
	}

	private wrap(text: string, width: number): string[] {
		return new Text(text, 0, 0).render(Math.max(1, width));
	}

	private accent(text: string): string {
		const bold = this.theme.bold ? this.theme.bold(text) : text;
		return this.theme.fg("accent", bold);
	}

	private currentPreview(): string | undefined {
		if (this.completed || this.editingQuestion !== undefined) return undefined;
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return undefined;
		if (state.cursor < 0 || state.cursor >= question.options.length) return undefined;
		return question.options[state.cursor]?.preview;
	}

	private moveFocus(delta: number): void {
		const total = this.questions.length;
		if (total === 0) return;
		this.focusedQuestion = (this.focusedQuestion + delta + total) % total;
		this.invalidate();
	}

	private moveCursor(delta: number): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		const total = question.options.length + 1;
		state.cursor = Math.max(0, Math.min(total - 1, state.cursor + delta));
		state.actionFocused = false;
		this.invalidate();
	}

	private toggleCursor(): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		if (state.cursor === question.options.length) {
			this.openEditor(this.focusedQuestion);
			return;
		}
		if (state.toggled.has(state.cursor)) state.toggled.delete(state.cursor);
		else state.toggled.add(state.cursor);
		if (state.answer) {
			const selected = [...state.toggled].sort((a, b) => a - b)
				.map((index) => question.options[index]!.label);
			// MULTI always records an array; custom omits it when no options remain.
			if (state.answer.kind === "custom" && selected.length === 0) delete state.answer.selected;
			else state.answer.selected = selected;
		}
		state.actionFocused = false;
		this.invalidate();
	}

	private focusRow(questionIndex: number, rowIndex: number): boolean {
		const question = this.questions[questionIndex];
		const state = this.states[questionIndex];
		if (!question || !state) return false;
		const changed = this.focusedQuestion !== questionIndex || state.cursor !== rowIndex;
		this.focusedQuestion = questionIndex;
		state.cursor = Math.max(0, Math.min(question.options.length, rowIndex));
		state.actionFocused = false;
		this.invalidate();
		return changed;
	}

	private commit(): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		const customIndex = question.options.length;

		if (state.cursor === customIndex) {
			this.openEditor(this.focusedQuestion);
			return;
		}

		if (question.multiSelect) {
			const toggled = [...state.toggled]
				.filter((index) => index < customIndex)
				.sort((a, b) => a - b);
			state.answer = {
				questionIndex: this.focusedQuestion,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: toggled.map((index) => question.options[index]!.label),
			};
			this.afterCommit(this.focusedQuestion);
			return;
		}

		const option = question.options[state.cursor];
		if (!option) return;
		state.answer = {
			questionIndex: this.focusedQuestion,
			question: question.question,
			kind: "option",
			answer: option.label,
			...(option.preview !== undefined ? { preview: option.preview } : {}),
		};
		this.afterCommit(this.focusedQuestion);
	}

	private openEditor(questionIndex: number): void {
		const state = this.states[questionIndex];
		if (!state) return;
		this.editingQuestion = questionIndex;
		this.syncEditorFocus();
		this.invalidate();
	}

	private closeEditor(): void {
		if (this.editingQuestion === undefined) return;
		this.editingQuestion = undefined;
		this.pasting = false;
		this.syncEditorFocus();
		this.invalidate();
	}

	private submitCustom(value: string): void {
		const questionIndex = this.editingQuestion;
		if (questionIndex === undefined) return;
		const question = this.questions[questionIndex];
		const state = this.states[questionIndex];
		if (!question || !state) {
			this.closeEditor();
			return;
		}
		if (value.trim().length === 0) {
			// Whitespace-only is treated as empty: discard it so reopening is clean.
			this.editors[questionIndex]!.setText("");
			this.closeEditor();
			return;
		}
		const customIndex = question.options.length;
		const selected = [...state.toggled]
			.filter((index) => index < customIndex)
			.sort((a, b) => a - b)
			.map((index) => question.options[index]!.label);
		state.answer = {
			questionIndex,
			question: question.question,
			kind: "custom",
			answer: value,
			...(question.multiSelect && selected.length > 0 ? { selected } : {}),
		};
		this.closeEditor();
		this.afterCommit(questionIndex);
	}

	private afterCommit(questionIndex: number): void {
		const state = this.states[questionIndex];
		if (state) state.actionFocused = true;
		this.invalidate();
	}

	private advance(): void {
		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return;
		if (!state.answer && question.multiSelect) {
			state.answer = {
				questionIndex: this.focusedQuestion,
				question: question.question,
				kind: "multi",
				answer: null,
				selected: [...state.toggled].sort((a, b) => a - b).map((index) => question.options[index]!.label),
			};
		}
		if (!state.answer) return;
		if (this.focusedQuestion === this.questions.length - 1) {
			if (this.states.every((entry) => entry.answer !== undefined)) {
				this.finish({ cancelled: false, answers: this.collectedAnswers() });
			}
			return;
		}
		this.focusedQuestion++;
		this.invalidate();
	}

	private collectedAnswers(): AnswerRow[] {
		return this.states
			.map((state) => state.answer)
			.filter((answer): answer is AnswerRow => answer !== undefined);
	}

	private finish(result: QuestionnaireResult): void {
		if (this.completed) return;
		this.completed = true;
		this.result = result;
		this.onComplete?.(result);
		this.invalidate();
	}

	private matches(
		data: string,
		binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
	): boolean {
		if (this.keybindings?.matches) return this.keybindings.matches(data, binding);
		const key = binding === "tui.select.up" ? "up"
			: binding === "tui.select.down" ? "down"
				: binding === "tui.select.confirm" ? "enter" : "escape";
		return matchesKey(data, key);
	}

	private matchesTab(data: string, shift: boolean): boolean {
		if (!shift && this.keybindings?.matches) return this.keybindings.matches(data, "tui.input.tab");
		return matchesKey(data, shift ? "shift+tab" : "tab");
	}

	private syncEditorFocus(): void {
		for (const [index, editor] of this.editors.entries()) {
			editor.focused = this._focused && this.editingQuestion === index;
		}
	}

	private matchesNewline(data: string): boolean {
		return this.keybindings?.matches(data, "tui.input.newLine") === true ||
			matchesKey(data, "shift+enter") || data === "\x1b[13;2~" ||
			data === "\x1b\r" || data === "\n";
	}

	private matchesSubmit(data: string): boolean {
		return this.keybindings?.matches(data, "tui.input.submit") ?? matchesKey(data, "enter");
	}

	private mouseTarget(event: TuiMouseEvent) {
		return {
			component: this,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		};
	}
}

function padTo(line: string, width: number): string {
	const padding = width - visibleWidth(line);
	return padding > 0 ? `${line}${" ".repeat(padding)}` : line;
}
