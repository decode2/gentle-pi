import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
	FrozenQuestionnaireRequest,
	QuestionPresentationDriver,
	RawQuestionnaireOutcome,
} from "./contract.ts";
import type { QuestionnaireExternalEditor } from "./external-editor.ts";
import type { QuestionnaireLocalizer } from "./localization.ts";
import { QuestionnaireTuiPresentation } from "./tui-presentation-view.ts";
import {
	createQuestionnairePresentationState,
	reduceQuestionnairePresentation,
	toRawQuestionnaireOutcome,
} from "./presentation-state.ts";

type DisposedComponent = Component & { dispose(): void };
type QuestionnaireTuiUI = Pick<ExtensionUIContext, "custom"> & Partial<Pick<ExtensionUIContext, "notify">>;

/** Bridges the public Pi custom-component host to the fullscreen questionnaire view. */
export function createTuiQuestionPresentationDriver(
	ui: QuestionnaireTuiUI,
	localize?: QuestionnaireLocalizer,
	externalEditor?: QuestionnaireExternalEditor,
	collapseKey?: string,
): QuestionPresentationDriver {
	return { async present(request: FrozenQuestionnaireRequest, signal?: AbortSignal): Promise<RawQuestionnaireOutcome> {
		if (signal?.aborted) return cancelledOutcome(request);

		let terminal = false;
		let view: QuestionnaireTuiPresentation | undefined;
		const detachAbort = () => signal?.removeEventListener("abort", abort);
		const terminate = () => {
			if (terminal) return;
			terminal = true;
			detachAbort();
			view?.dispose();
		};
		const abort = () => {
			if (terminal) return;
			if (view) return view.cancel();
			terminal = true;
			detachAbort();
		};
		signal?.addEventListener("abort", abort, { once: true });

		try {
			return await ui.custom<RawQuestionnaireOutcome>((tui, theme, keybindings, done) => {
				if (terminal) return disposedComponent();
				view = new QuestionnaireTuiPresentation({
					tui,
					theme,
					keybindings,
					localize,
					collapseKey,
					externalEditor: externalEditor === undefined ? undefined : (draft) => runExternalEditor(tui, externalEditor, draft),
					onExternalEditorError: (message) => {
						try {
							ui.notify?.(message, "error");
						} catch {
							// Error notification is best effort after the editor failure is contained.
						}
					},
					request,
					onDone: (outcome) => {
						if (terminal) return;
						terminate();
						// The view disposes before onDone; adapter cleanup is idempotent.
						done(outcome);
					},
				});
				return view;
			}, {
				overlay: true,
				overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 0 },
			});
		} catch (error) {
			terminate();
			throw error;
		} finally {
			terminate();
		}
	} };
}

async function runExternalEditor(tui: import("@earendil-works/pi-tui").TUI, externalEditor: QuestionnaireExternalEditor, draft: string): Promise<string> {
	let primaryFailed = false;
	try {
		tui.stop({ preserveScreen: true });
		return await externalEditor(draft);
	} catch (error) {
		primaryFailed = true;
		throw error;
	} finally {
		let restoreFailed = false;
		let restoreError: unknown;
		try {
			tui.start();
		} catch (error) {
			restoreFailed = true;
			restoreError = error;
		}
		try {
			tui.requestRender(true);
		} catch (error) {
			if (!restoreFailed) {
				restoreFailed = true;
				restoreError = error;
			}
		}
		if (!primaryFailed && restoreFailed) throw restoreError;
	}
}

function cancelledOutcome(request: FrozenQuestionnaireRequest): RawQuestionnaireOutcome {
	const state = reduceQuestionnairePresentation(createQuestionnairePresentationState(request), { type: "cancel" });
	return toRawQuestionnaireOutcome(state);
}

function disposedComponent(): DisposedComponent {
	return { render: () => [], invalidate: () => {}, dispose: () => {} };
}
