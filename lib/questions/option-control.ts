import {
	Box,
	Container,
	isKeyRelease,
	matchesKey,
	stripTerminalSequences,
	Text,
	truncateToWidth,
	type KeybindingsManager,
	type TuiMouseEvent,
	type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { NativePointerScope, type NativePointerMouseObserver } from "../native-pointer-region.ts";

export interface QuestionOptionControlItem {
	readonly id: string;
	readonly label: string;
	readonly description: string;
	readonly preview?: string;
}

export type QuestionOptionControlAction =
	| { readonly type: "focus-option"; readonly index: number; readonly option: QuestionOptionControlItem }
	| { readonly type: "select-option"; readonly index: number; readonly option: QuestionOptionControlItem }
	| { readonly type: "toggle-option"; readonly index: number; readonly option: QuestionOptionControlItem; readonly selected: boolean };

export interface QuestionOptionControlTheme {
	selectedPrefix(text: string): string;
	selectedText(text: string): string;
	description(text: string): string;
	preview(text: string): string;
	hoverBackground(text: string): string;
}

type ContainerMouseResult = ReturnType<Container["handleMouse"]>;

export interface QuestionOptionControlOptions {
	readonly items: readonly QuestionOptionControlItem[];
	readonly multiSelect: boolean;
	readonly selectedIds?: readonly string[];
	readonly focusedId?: string;
	readonly theme: QuestionOptionControlTheme;
	readonly keybindings?: KeybindingsManager;
	readonly onAction?: (action: QuestionOptionControlAction) => void;
	readonly onCancel?: () => void;
}

interface Row {
	readonly item: QuestionOptionControlItem;
	readonly text: Text;
	readonly box: Box;
}

/** A display-only option control; its caller owns validation and question commits. */
export class QuestionOptionControl extends Container {
	private items: readonly QuestionOptionControlItem[];
	private readonly multiSelect: boolean;
	private readonly theme: QuestionOptionControlTheme;
	private readonly keybindings: KeybindingsManager | undefined;
	private readonly onAction: ((action: QuestionOptionControlAction) => void) | undefined;
	private readonly onCancel: (() => void) | undefined;
	private readonly rows: Row[] = [];
	private pointerScope = new NativePointerScope();
	private selectedIds: readonly string[];
	private focusedIndex: number;
	private hoveredId: string | undefined;
	private disabled = false;
	private lastRenderWidth: number | undefined;
	private mouseReady = false;
	private disposed = false;

	constructor(options: QuestionOptionControlOptions) {
		super();
		this.items = validItems(options.items);
		this.multiSelect = options.multiSelect;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.onAction = options.onAction;
		this.onCancel = options.onCancel;
		this.selectedIds = validSelectedIds(options.selectedIds ?? [], this.items, this.multiSelect);
		const focused = options.focusedId === undefined ? -1 : this.indexOf(options.focusedId);
		this.focusedIndex = focused >= 0 ? focused : this.items.length === 0 ? -1 : 0;
		for (const item of this.items) this.addRow(item);
		this.refreshRows();
	}

	getFocusedOption(): QuestionOptionControlItem | undefined {
		return this.items[this.focusedIndex];
	}

	/** Throws TypeError unless selected IDs are known, unique, and valid for the selection mode. */
	setSelectedIds(selectedIds: readonly string[]): void {
		this.selectedIds = validSelectedIds(selectedIds, this.items, this.multiSelect);
		this.refreshRows();
	}

	/** Replaces items only while live; IDs remain unique and existing selection stays valid. */
	setItems(items: readonly QuestionOptionControlItem[]): void {
		if (this.disposed) return;
		const nextItems = validItems(items);
		const nextSelected = validSelectedIds(this.selectedIds, nextItems, this.multiSelect);
		const focusedId = this.getFocusedOption()?.id;
		this.pointerScope.dispose();
		this.pointerScope = new NativePointerScope();
		this.clear();
		this.rows.length = 0;
		this.items = nextItems;
		this.selectedIds = nextSelected;
		this.focusedIndex = focusedId === undefined ? (nextItems.length === 0 ? -1 : 0) : Math.max(0, this.indexOf(focusedId));
		this.lastRenderWidth = undefined;
		this.mouseReady = false;
		for (const item of nextItems) this.addRow(item);
		this.refreshRows();
	}

	/** Permanently detaches pointer regions. A disposed control cannot be revived. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.lastRenderWidth = undefined;
		this.mouseReady = false;
		this.clearHover();
		this.pointerScope.dispose();
		this.clear();
		this.rows.length = 0;
	}

	setFocusedId(id: string): void {
		if (!this.disposed) this.focus(this.indexOf(id), false);
	}

	setDisabled(disabled: boolean): void {
		if (this.disposed) return;
		this.disabled = disabled;
		this.pointerScope.setDisabled(disabled);
		if (disabled) this.clearHover();
	}

	createMouseObserver(requestRender: () => void): NativePointerMouseObserver {
		return {
			beforeMouse: (event) => this.pointerScope.createMouseObserver(requestRender).beforeMouse(event),
			afterMouse: (event) => this.pointerScope.createMouseObserver(requestRender).afterMouse(event),
		};
	}

	handleInput(data: string): void {
		if (this.disposed || this.disabled || isKeyRelease(data)) return;
		if (this.matches(data, "tui.select.up")) this.focus(this.focusedIndex - 1, true);
		else if (this.matches(data, "tui.select.down")) this.focus(this.focusedIndex + 1, true);
		else if (this.matches(data, "tui.select.confirm")) this.activate(this.focusedIndex);
		else if (this.matches(data, "tui.select.cancel")) this.onCancel?.();
	}

	override handleMouse(event: TuiMouseEvent): ContainerMouseResult {
		if (this.disposed || !this.mouseReady || event.width !== this.lastRenderWidth) return undefined;
		const result = super.handleMouse(event);
		if (result || this.disabled || event.type !== "wheel" || !event.wheelDelta) return result;
		const changed = this.focus(this.focusedIndex + (event.wheelDelta < 0 ? -1 : 1), true);
		return mouseDispatchResult(this, event, changed);
	}

	override render(width: number): string[] {
		if (this.disposed) return [];
		const boundedWidth = Math.max(0, Math.floor(width));
		if (this.lastRenderWidth !== boundedWidth) {
			this.lastRenderWidth = undefined;
			this.mouseReady = false;
			this.pointerScope.invalidate();
		}
		if (boundedWidth === 0) return [];
		const lines = super.render(boundedWidth).map((line) => truncateToWidth(line, boundedWidth, ""));
		this.lastRenderWidth = boundedWidth;
		this.mouseReady = true;
		return lines;
	}

	override invalidate(): void {
		this.lastRenderWidth = undefined;
		this.mouseReady = false;
		this.pointerScope.invalidate();
		super.invalidate();
	}

	private addRow(item: QuestionOptionControlItem): void {
		const text = new Text("", 1, 0);
		const box = new Box(0, 0, (value) => this.hoveredId === item.id ? this.theme.hoverBackground(value) : value);
		box.addChild(text);
		this.rows.push({ item, text, box });
		this.addChild(this.pointerScope.wrap(box, {
			onHover: (event) => this.handleRowMouse(item, event),
			onLeave: () => this.clearHover(),
			onPress: (event) => this.handleRowMouse(item, event),
			onClick: (event) => this.handleRowMouse(item, event),
		}));
	}

	private handleRowMouse(item: QuestionOptionControlItem, event: TuiMouseEvent): TuiMouseEventResult | undefined {
		if (this.disposed || !this.mouseReady || this.disabled) return undefined;
		if (event.type === "move" && event.button === "none") {
			const changed = this.setHover(item.id);
			return { handled: true, render: changed };
		}
		if (event.button !== "left") return undefined;
		const index = this.indexOf(item.id);
		if (event.type === "press") return { handled: true, focus: true, render: this.focus(index, true) };
		if (event.type === "click") {
			this.activate(index);
			return { handled: true };
		}
		return undefined;
	}

	private focus(index: number, emit: boolean): boolean {
		const next = Math.max(0, Math.min(this.items.length - 1, index));
		if (this.items.length === 0 || next === this.focusedIndex) return false;
		this.focusedIndex = next;
		this.refreshRows();
		if (emit) this.onAction?.({ type: "focus-option", index: next, option: this.items[next]! });
		return true;
	}

	private activate(index: number): void {
		const option = this.items[index];
		if (!option) return;
		if (!this.multiSelect) {
			this.selectedIds = [option.id];
			this.refreshRows();
			this.onAction?.({ type: "select-option", index, option });
			return;
		}
		const selected = !this.selectedIds.includes(option.id);
		this.selectedIds = selected
			? [...this.selectedIds, option.id]
			: this.selectedIds.filter((id) => id !== option.id);
		this.refreshRows();
		this.onAction?.({ type: "toggle-option", index, option, selected });
	}

	private setHover(id: string): boolean {
		if (this.hoveredId === id) return false;
		this.hoveredId = id;
		this.refreshRows();
		return true;
	}

	private clearHover(): boolean {
		if (this.hoveredId === undefined) return false;
		this.hoveredId = undefined;
		this.refreshRows();
		return true;
	}

	private refreshRows(): void {
		for (const [index, row] of this.rows.entries()) {
			const selected = this.selectedIds.includes(row.item.id);
			const focused = index === this.focusedIndex;
			const pointer = focused ? this.theme.selectedPrefix("→ ") : "  ";
			const marker = this.multiSelect ? selected ? "[x] " : "[ ] " : selected ? "(●) " : "( ) ";
			const label = display(row.item.label);
			const lines = [`${pointer}${marker}${focused ? this.theme.selectedText(label) : label}`];
			lines.push(`   ${this.theme.description(display(row.item.description))}`);
			if (row.item.preview !== undefined) lines.push(`   ${this.theme.preview(`Preview: ${display(row.item.preview)}`)}`);
			row.text.setText(lines.join("\n"));
			row.box.invalidate();
		}
	}

	private matches(data: string, binding: "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel"): boolean {
		if (this.keybindings?.matches) return this.keybindings.matches(data, binding);
		const key = binding === "tui.select.up" ? "up"
			: binding === "tui.select.down" ? "down"
				: binding === "tui.select.confirm" ? "enter" : "escape";
		return matchesKey(data, key);
	}

	private indexOf(id: string): number {
		return this.items.findIndex((item) => item.id === id);
	}
}

const C1_STRING = /[\u0090\u0098\u009d\u009e\u009f][^\u0007\u009c]*(?:[\u0007\u009c]|$)/g;
const C1_CSI = /\u009b[\u0030-\u003f]*[\u0020-\u002f]*[\u0040-\u007e]/g;
const UNSAFE_CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

function display(value: string): string {
	return stripTerminalSequences(value)
		.replace(C1_STRING, "")
		.replace(C1_CSI, "")
		.replace(UNSAFE_CONTROL, "");
}

function mouseDispatchResult(component: Container, event: TuiMouseEvent, render: boolean): Exclude<ContainerMouseResult, undefined> {
	return {
		handled: true,
		render,
		target: {
			component,
			originX: event.screenX - event.x,
			originY: event.screenY - event.y,
			width: event.width,
			height: event.height,
		},
	};
}

function validItems(items: readonly QuestionOptionControlItem[]): readonly QuestionOptionControlItem[] {
	if (!Array.isArray(items) || items.some((item) => !item || typeof item.id !== "string" || item.id.length === 0)) {
		throw new TypeError("QuestionOptionControl items require non-empty string IDs");
	}
	const copy = [...items];
	if (new Set(copy.map((item) => item.id)).size !== copy.length) {
		throw new TypeError("QuestionOptionControl item IDs must be unique");
	}
	return copy;
}

function validSelectedIds(
	selectedIds: readonly string[], items: readonly QuestionOptionControlItem[], multiSelect: boolean,
): readonly string[] {
	if (!Array.isArray(selectedIds) || (!multiSelect && selectedIds.length > 1)) {
		throw new TypeError("QuestionOptionControl selected IDs do not match the selection mode");
	}
	const ids = new Set(selectedIds);
	if (ids.size !== selectedIds.length || [...ids].some((id) => typeof id !== "string" || !items.some((item) => item.id === id))) {
		throw new TypeError("QuestionOptionControl selected IDs must be known and unique");
	}
	return [...selectedIds];
}
