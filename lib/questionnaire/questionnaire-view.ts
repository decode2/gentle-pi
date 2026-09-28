import {
	Container,
	CURSOR_MARKER,
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
import { stripAnsi } from "../terminal-theme.ts";
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
	editorTheme: EditorTheme;
	keybindings?: KeybindingsManager;
	onComplete?: (result: QuestionnaireResult) => void;
}

interface QuestionState {
	cursor: number;
	toggled: Set<number>;
	answer: AnswerRow | undefined;
	editor: Editor;
	actionFocused: boolean;
}

type QuestionLineOwner = { questionIndex: number; rowIndex: number };
type WheelRange = { start: number; end: number };
type BodyLineOwner = QuestionLineOwner & { wheelRanges: WheelRange[] };

type LineOwner =
	| BodyLineOwner
	| { action: "advance" | "cancel"; width: number };

/**
 * One-question-at-a-time questionnaire.
 *
 * The whole questionnaire is represented as a compact tab strip: exactly one
 * question body is rendered at a time, and Tab/Shift-Tab switches the active
 * question while each question keeps its own cursor, toggles, and custom-text
 * draft. The owned body viewport is bounded by the current terminal row
 * budget, with navigation and resize keeping the active row visible.
 *
 * This is a {@link Container}, not an overlay. Host dock sizing and transcript
 * routing remain outside this component's contract. Keyboard handling uses
 * the public Pi TUI input protocol (`matchesKey()` and the injected
 * `KeybindingsManager`).
 */
export class QuestionnaireView extends Container implements Focusable {
	private readonly questions: QuestionData[];
	private readonly theme: QuestionnaireTheme;
	private readonly tui: TUI;
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onComplete: ((result: QuestionnaireResult) => void) | undefined;
	private readonly states: QuestionState[];
	private focusedQuestion = 0;
	private editingQuestion: number | undefined;
	private completed = false;
	private result: QuestionnaireResult | undefined;
	private lineOwners: Array<LineOwner | undefined> = [];
	private bodyStart = 0;
	private bodyHeight = 0;
	private bodyLineCount = 0;
	private bodyScroll = 0;
	private renderedWidth = 0;
	private renderedTerminalRows = 0;
	private keepFocusedVisible = true;
	private editorMouseStart: number | undefined;
	private editorMouseWidth = 0;
	private editorMouseHeight = 0;
	private editorMouseEditorHeight = 0;
	private editorMouseOffset = 0;
	private _focused = false;

	constructor(options: QuestionnaireViewOptions) {
		super();
		this.questions = options.questions;
		this.theme = options.theme;
		this.tui = options.tui;
		this.keybindings = options.keybindings;
		this.onComplete = options.onComplete;
		this.states = options.questions.map(() => ({
			cursor: 0,
			toggled: new Set<number>(),
			answer: undefined,
			editor: new Editor(options.tui, options.editorTheme),
			actionFocused: false,
		}));
		// An optional MULTI can be submitted without choosing an option.
		for (const [index, question] of options.questions.entries()) {
			if (question.multiSelect) this.states[index]!.actionFocused = true;
		}
	}

	/** Focusable: propagate focus so the free-text input gets the IME cursor. */
	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
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
			const state = this.states[this.editingQuestion];
			if (!state) return;
			// Tab still switches questions while editing; each Editor retains its draft and caret.
			if (this.matchesTab(data, false)) {
				this.closeEditor();
				this.moveFocus(1);
				return;
			}
			if (this.matchesTab(data, true)) {
				this.closeEditor();
				this.moveFocus(-1);
				return;
			}
			if (this.matches(data, "tui.select.cancel")) {
				this.closeEditor();
				return;
			}
			// Editor.submitValue() trims and clears, so capture expanded content first.
			if (this.matchesEditorSubmit(data)) {
				this.submitCustom(state.editor.getExpandedText());
				return;
			}
			state.editor.handleInput(data);
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

	override handleMouse(event: TuiMouseEvent) {
		if (this.completed || event.width !== this.renderedWidth ||
			(this.tui.terminal?.rows ?? 24) !== this.renderedTerminalRows) return undefined;
		if (event.type === "wheel") {
			const owner = this.lineOwners[event.y];
			if (event.y < this.bodyStart || event.y >= this.bodyStart + this.bodyHeight ||
				!owner || !("questionIndex" in owner) ||
				!owner.wheelRanges.some((range) => event.x >= range.start && event.x < range.end)) return undefined;
			const maxScroll = Math.max(0, this.bodyLineCount - this.bodyHeight);
			const delta = event.wheelDelta ?? 0;
			if (delta === 0) return undefined;
			const step = Math.max(1, Math.abs(delta));
			const nextScroll = Math.max(0, Math.min(maxScroll, this.bodyScroll + Math.sign(delta) * step));
			if (nextScroll === this.bodyScroll) return undefined;
			this.bodyScroll = nextScroll;
			this.invalidate();
			this.keepFocusedVisible = false;
			return { handled: true as const, focus: true, render: true, target: this.mouseTarget(event) };
		}
		if (this.editingQuestion !== undefined) {
			const state = this.states[this.editingQuestion];
			if (
				!state ||
				this.editorMouseStart === undefined ||
				event.y < this.editorMouseStart ||
				event.y >= this.editorMouseStart + this.editorMouseHeight
			) return undefined;
			const result = state.editor.handleMouse({
				...event,
				y: event.y - this.editorMouseStart + this.editorMouseOffset,
				width: this.editorMouseWidth,
				height: this.editorMouseEditorHeight,
			});
			return result?.handled ? { ...result, handled: true as const, target: this.mouseTarget(event) } : undefined;
		}

		const owner = this.lineOwners[event.y];
		if (!owner || event.button !== "left") return undefined;
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
		const terminalRows = this.tui.terminal?.rows ?? 24;
		if (viewport !== this.renderedWidth || terminalRows !== this.renderedTerminalRows) this.keepFocusedVisible = true;
		this.renderedWidth = viewport;
		this.renderedTerminalRows = terminalRows;
		const lines: string[] = [];
		const owners: Array<LineOwner | undefined> = [];
		this.editorMouseStart = undefined;
		this.editorMouseWidth = 0;
		this.editorMouseHeight = 0;
		this.editorMouseEditorHeight = 0;
		this.editorMouseOffset = 0;
		const rowBudget = Math.max(1, terminalRows - 2);
		const fixedBudget = Math.max(0, rowBudget - 1);
		const showTabs = fixedBudget >= 3;
		const actionRows = fixedBudget >= 3 ? 2 : fixedBudget;
		const showHint = fixedBudget >= 4;
		const requiredFixedRows = (showTabs ? 1 : 0) + actionRows + (showHint ? 1 : 0);
		const spacerRows = Math.min(2, Math.max(0, fixedBudget - requiredFixedRows));
		const push = (text: string, owner?: LineOwner) => {
			for (const line of this.wrap(text, viewport)) {
				lines.push(line);
				owners.push(owner);
			}
		};
		const pushFixed = (line: string) => {
			lines.push(line);
			owners.push(undefined);
		};

		if (this.questions.length === 0) {
			this.lineOwners = [];
			return [];
		}

		if (showTabs) pushFixed(this.wrap(this.renderTabs(), viewport)[0] ?? "");
		if (spacerRows > 0) pushFixed("");
		const bodyStart = lines.length;
		let bodyAnchor: number | undefined;

		const preview = this.currentPreview();
		if (preview !== undefined && viewport >= MIN_PREVIEW_WIDTH) {
			const leftWidth = Math.max(1, Math.floor(viewport * PREVIEW_SPLIT));
			const rightWidth = Math.max(1, viewport - leftWidth - PREVIEW_GAP.length);
			const left = this.renderBody(leftWidth, false);
			const right = this.wrap(this.theme.fg("dim", preview), rightWidth);
			const rows = Math.max(left.lines.length, right.length);
			for (let index = 0; index < rows; index++) {
				const leftLine = left.lines[index] ?? "";
				const rightLine = right[index] ?? "";
				const leftOwner = left.owners[index] ?? {
					questionIndex: this.focusedQuestion,
					rowIndex: -1,
					wheelRanges: [],
				};
				const rightStart = leftWidth + PREVIEW_GAP.length;
				const rightTextWidth = renderedTextWidth(rightLine);
				lines.push(`${padTo(leftLine, leftWidth)}${PREVIEW_GAP}${rightLine}`);
				owners.push({
					...leftOwner,
					wheelRanges: [
						...leftOwner.wheelRanges,
						...(rightTextWidth > 0 ? [{ start: rightStart, end: rightStart + rightTextWidth }] : []),
					],
				});
			}
		}
		else {
			const body = this.renderBody(viewport, preview !== undefined);
			lines.push(...body.lines);
			owners.push(...body.owners);
			bodyAnchor = body.editorAnchor;
			if (body.editorOffset !== undefined) {
				this.editorMouseStart = bodyStart + body.editorOffset;
				this.editorMouseWidth = viewport;
				this.editorMouseHeight = body.editorHeight ?? 0;
				this.editorMouseEditorHeight = body.editorHeight ?? 0;
			}
		}
		const bodyEnd = lines.length;

		if (spacerRows > 1) pushFixed("");
		if (this.editingQuestion === undefined) {
			const action = this.focusedQuestion === this.questions.length - 1 ? "Submit" : "Next";
			const actions = [[action, "advance"], ["Cancel", "cancel"]] as const;
			for (const [label, kind] of actions.slice(0, actionRows)) {
				const styled = kind === "advance" && this.states[this.focusedQuestion]?.actionFocused
					? this.accent(label) : this.theme.fg("muted", label);
				const line = this.wrap(styled, viewport)[0] ?? "";
				lines.push(line);
				owners.push({ action: kind, width: Math.min(visibleWidth(line), visibleWidth(label)) });
			}
		}
		if (showHint) pushFixed(this.wrap(this.hint(), viewport)[0] ?? "");

		const bodyCount = bodyEnd - bodyStart;
		const fixedRows = lines.length - bodyCount;
		this.bodyHeight = Math.min(bodyCount, Math.max(1, rowBudget - fixedRows));
		this.bodyLineCount = bodyCount;
		this.bodyStart = bodyStart;
		const state = this.states[this.focusedQuestion];
		const focusedLine = bodyAnchor ?? owners.slice(bodyStart, bodyEnd).findIndex((owner) =>
			owner !== undefined && "questionIndex" in owner &&
			owner.questionIndex === this.focusedQuestion && owner.rowIndex === state?.cursor);
		const maxScroll = Math.max(0, bodyCount - this.bodyHeight);
		if (this.keepFocusedVisible && focusedLine >= 0) {
			if (focusedLine < this.bodyScroll) this.bodyScroll = focusedLine;
			else if (focusedLine >= this.bodyScroll + this.bodyHeight) this.bodyScroll = focusedLine - this.bodyHeight + 1;
		}
		this.bodyScroll = Math.max(0, Math.min(maxScroll, this.bodyScroll));
		lines.splice(bodyStart, bodyCount, ...lines.slice(bodyStart + this.bodyScroll, bodyStart + this.bodyScroll + this.bodyHeight));
		owners.splice(bodyStart, bodyCount, ...owners.slice(bodyStart + this.bodyScroll, bodyStart + this.bodyScroll + this.bodyHeight));
		if (this.editorMouseStart !== undefined) {
			const editorEnd = this.editorMouseStart + this.editorMouseHeight;
			const visibleStart = Math.max(this.editorMouseStart, bodyStart + this.bodyScroll);
			const visibleEnd = Math.min(editorEnd, bodyStart + this.bodyScroll + this.bodyHeight);
			this.editorMouseOffset = visibleStart - this.editorMouseStart;
			this.editorMouseHeight = Math.max(0, visibleEnd - visibleStart);
			this.editorMouseStart = visibleStart - this.bodyScroll;
		}
		this.keepFocusedVisible = false;
		this.lineOwners = owners;
		return lines;
	}

	override invalidate(): void {
		this.keepFocusedVisible = true;
		this.lineOwners = [];
		this.editorMouseStart = undefined;
		this.editorMouseWidth = 0;
		this.editorMouseHeight = 0;
		this.editorMouseEditorHeight = 0;
		this.editorMouseOffset = 0;
		for (const [index, state] of this.states.entries()) {
			state.editor.focused = this.editingQuestion === index && this._focused;
		}
		super.invalidate();
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
	private renderBody(width: number, inlinePreview: boolean): {
		lines: string[];
		owners: Array<BodyLineOwner | undefined>;
		editorOffset?: number;
		editorHeight?: number;
		editorAnchor?: number;
	} {
		const lines: string[] = [];
		const owners: Array<BodyLineOwner | undefined> = [];
		const push = (text: string, owner?: QuestionLineOwner) => {
			for (const line of this.wrap(text, width)) {
				lines.push(line);
				owners.push(owner ? { ...owner, wheelRanges: [{ start: 0, end: renderedTextWidth(line) }] } : undefined);
			}
		};

		const question = this.questions[this.focusedQuestion];
		const state = this.states[this.focusedQuestion];
		if (!question || !state) return { lines, owners };

		const headerOwner: QuestionLineOwner = { questionIndex: this.focusedQuestion, rowIndex: -1 };
		push(this.accent(question.question), headerOwner);

		if (this.editingQuestion === this.focusedQuestion) {
			push(" Custom response > ");
			const editorOffset = lines.length;
			const editorLines = state.editor.render(width);
			lines.push(...editorLines);
			owners.push(...editorLines.map((line) => ({
				...headerOwner,
				wheelRanges: [{ start: 0, end: renderedTextWidth(line) }],
			})));
			const caretLine = editorLines.findIndex((line) => line.includes(CURSOR_MARKER));
			return {
				lines,
				owners,
				editorOffset,
				editorHeight: editorLines.length,
				editorAnchor: editorOffset + Math.max(0, caretLine),
			};
		}

		const customIndex = question.options.length;
		for (const [optionIndex, option] of question.options.entries()) {
			const owner: QuestionLineOwner = { questionIndex: this.focusedQuestion, rowIndex: optionIndex };
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

		const customOwner: QuestionLineOwner = { questionIndex: this.focusedQuestion, rowIndex: customIndex };
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
		this.invalidate();
	}

	private closeEditor(): void {
		if (this.editingQuestion === undefined) return;
		this.editingQuestion = undefined;
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
			state.editor.setText("");
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

	private matchesEditorSubmit(data: string): boolean {
		if (this.keybindings?.matches) return this.keybindings.matches(data, "tui.input.submit");
		return matchesKey(data, "enter");
	}

	private matchesTab(data: string, shift: boolean): boolean {
		if (!shift && this.keybindings?.matches) return this.keybindings.matches(data, "tui.input.tab");
		return matchesKey(data, shift ? "shift+tab" : "tab");
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

function renderedTextWidth(line: string): number {
	return visibleWidth(stripAnsi(line).trimEnd());
}

function padTo(line: string, width: number): string {
	const padding = width - visibleWidth(line);
	return padding > 0 ? `${line}${" ".repeat(padding)}` : line;
}
