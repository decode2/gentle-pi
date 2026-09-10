import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import type {
	FrozenQuestionnaireRequest,
	QuestionPresentationDriver,
	RawQuestionnaireOutcome,
} from "./contract.ts";
import { QuestionnaireTuiPresentation } from "./tui-presentation-view.ts";
import {
	createQuestionnairePresentationState,
	reduceQuestionnairePresentation,
	toRawQuestionnaireOutcome,
} from "./presentation-state.ts";

type DisposedComponent = Component & { dispose(): void };

/** Bridges the public Pi custom-component host to the fullscreen questionnaire view. */
export function createTuiQuestionPresentationDriver(
	ui: Pick<ExtensionUIContext, "custom">,
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

function cancelledOutcome(request: FrozenQuestionnaireRequest): RawQuestionnaireOutcome {
	const state = reduceQuestionnairePresentation(createQuestionnairePresentationState(request), { type: "cancel" });
	return toRawQuestionnaireOutcome(state);
}

function disposedComponent(): DisposedComponent {
	return { render: () => [], invalidate: () => {}, dispose: () => {} };
}
