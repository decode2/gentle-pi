# Let custom views use the configured external editor safely

**Decision:** Pi should eventually expose one host-owned external-edit operation through `ctx.ui`. The questionnaire will consume that public capability later. UQA-07b defines the boundary only; it does not authorize implementation in Pi core, the SDK, or the questionnaire.

## Proposed public contract

```ts
interface ExternalEditOptions {
  signal?: AbortSignal;
}

type ExternalEditResult =
  | { status: "submitted"; text: string }
  | { status: "cancelled" }; // The caller's signal invalidated delivery.

interface ExtensionUIContext {
  externalEdit(text: string, options?: ExternalEditOptions): Promise<ExternalEditResult>;
}
```

The final API name may follow Pi's public naming conventions, but its ownership boundary must remain unchanged: the extension supplies draft text and an optional signal; Pi chooses and launches the configured editor.

## Required behavior

| Area | Contract |
|---|---|
| Availability | The operation is available only in interactive TUI mode, like the other `ctx.ui` operations. |
| Command ownership | Pi resolves the configured editor and applies its existing settings and trust rules. Extensions cannot supply or inspect the executable command. |
| Active custom view | A non-overlay `ctx.ui.custom()` view remains the active view instance. Opening the editor must not replace it with another prompt or require an internal component import. |
| Terminal handoff | Pi suspends the terminal before launch and restores it in `finally` after success, cancellation, or failure. It then requests a render of the retained custom view. |
| Success | Normal process completion returns the edited text as `submitted`, including when the text is unchanged. External editors have no separate intrinsic cancel signal. |
| Cancellation | `cancelled` means only that the caller's signal was already aborted or became aborted before result delivery. Abort wins over later child-exit or readback outcomes: Pi records cleanup/process failures for observability but does not deliver them to the invalidated caller. If no process started, cancellation may settle immediately; otherwise it settles only after the child exits and Pi restores the terminal. It never fabricates edited text. |
| Abort | Aborting invalidates the caller's ownership immediately but does not terminate the child process. The operation promise remains pending while an already-running child owns the terminal, then resolves `cancelled` after terminal restoration. The questionnaire settles independently and must not await that cleanup to cancel. |
| Late completion | A disposed, cancelled, superseded, or reloaded custom view must ignore a later result. Consumers compare a view/editor generation token before applying text. |
| Reload | Reload or extension shutdown invalidates delivery to the old extension frame. Pi retains responsibility for restoring the terminal even when the original consumer no longer exists. |
| Concurrency | One external edit may own the interactive terminal at a time. A concurrent request fails explicitly instead of replacing or interleaving sessions. |
| Errors | While the caller's signal remains current, launch, temporary-file, readback, and non-success process failures reject with a stable host error after terminal restoration. An abort observed before delivery takes precedence and resolves `cancelled` instead. |

## Consumer protocol

A future questionnaire integration should follow this sequence:

1. Capture the current draft and a generation token.
2. Call the public host operation with the questionnaire abort signal.
3. On completion, confirm that the view is still mounted and the generation is current.
4. Apply only a `submitted` result that passes those checks.
5. Settle questionnaire cancellation from its own signal; do not wait for an external-editor child to exit.
6. Ignore cancelled or stale editor results without recreating the view.

Only custom-answer drafts should initially expose this action. Option selection and note editors stay unchanged unless separately specified.

## Acceptance tests for a future implementation

- A non-overlay custom view keeps the same instance and draft state after successful external editing.
- Launch failure restores the terminal and leaves the draft unchanged.
- Abort settles the questionnaire immediately; the editor operation remains pending until child exit and terminal restoration, then returns `cancelled` without updating the draft, even when that late child exits unsuccessfully.
- Reload or extension shutdown cannot deliver text into the obsolete extension frame.
- A second concurrent launch fails explicitly while the first retains terminal ownership.
- Public types and extension documentation describe availability, results, errors, and lifecycle ownership.
- Host integration tests use the configured command without exposing it to the extension.

## Deliberately out of scope

- Importing `ExtensionEditorComponent` or other interactive-mode internals.
- Reimplementing command resolution, temporary files, or process launch in the questionnaire.
- Killing the editor child process when the questionnaire aborts.
- Nesting `ctx.ui.editor()` and attempting to reconstruct the questionnaire dock afterward.
- Implementing this contract as part of UQA-07b.

## Follow-up

Implementation should be proposed as a separate Pi core/SDK work unit with its own strict RED/GREEN evidence and lifecycle review. The questionnaire can adopt it only after the public host contract exists.
