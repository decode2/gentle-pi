# Upstream questionnaire adaptation

Adapt Alan's merged upstream questionnaire instead of transplanting the owned implementation, while retaining the already-approved RPC and UX requirements.

## Identity and authorization

- Repository/worktree: `decode2/gentle-pi`, `questionnaire-visual-polish-5594c1f4`; keep the existing branch and one writer.
- Upstream base: `Gentleman-Programming/gentle-shell` commit `f2d9d073ffc2299eb501902753b42789f7cdc461`, tree `6fb42857f728f131da054e592ec5d22c691ce870`, merged PR #1274 by Alan-TheGentleman.
- User selected upstream adaptation in decision 16829 and authorized ODD implementation in decision 16831.
- Preserve the historical `fe70f7fd2e1d692eb3790adebb53a10c8b34e64c` artifact-composition evidence and its immutable old-main pin. Do not retarget or relax that artifact.
- No new branch, activation, package removal, normal/lab configuration change, PR, main push/merge or auto-merge is authorized.

## Constraints and verification

- No local Node/npm/SDK/compiler/test/build/install/formatter/Docker/native execution. Execution evidence comes from exact-SHA hosted CI.
- Strict TDD remains enabled from the retained session choice. Behavioral units require observed hosted RED before implementation, then GREEN. Acquisition/characterization work does not fabricate production RED.
- General hard cap: 400 additions plus deletions per unit, including tests and tracking; the historical 475-line exception does not carry forward. No line-golfing or assertion removal.
- Generated artifacts, source/dependencies and runtime inputs remain immutable and isolated. Network is allowed only during bounded acquisition; validation uses network none, read-only inputs/root, UID 1000, zero capabilities, no-new-privileges and clean credentials.
- Upstream owns the questionnaire extension unconditionally. Hosted profiles must select exactly one provider. The legacy owner gate does not govern upstream.
- Preserve upstream custom-plus-MULTI selected results. Do not import the owned validator's narrower rejection.
- Keep shared `lib/native-fullscreen-interaction.ts` unchanged unless separately justified and authorized.
- Full-package startup, native review, human Herder acceptance and migration remain separate gates.

## Retained requirements

1. RPC `select` plus editor/input fallback, abort handling and partial results.
2. Question/global notes in success and cancellation results.
3. Valid empty MULTI and always-available custom response; preserve upstream custom-plus-selected results.
4. Explicit vertical Submit above Cancel and reachable controls.
5. Preview scrolling/resizing and usable narrow/short terminal layout, adapted to the upstream dock.
6. Configurable navigation/editor bindings, including explicit disabled `[]`, multiline editing and the required external-editor binding.
7. Balanced blocked events compatible with the real Herdr consumer, reload safety and exactly one selected provider.

## Tasks

- [x] **UQA-00 — Select and map the upstream base.** Read-only evidence in Engram 16794 and planning handoff `muaf395g-1b-0raa`; upstream is not a drop-in replacement. Route: delegated mapping because more than four files/dependencies were required.
- [x] **UQA-01 — Acquire and identify current upstream immutably.** Verified at `33cdcd47172ff0dc39412fd0c387eb8f3578ceb5`, CI 35549012990: two acquisition tests, scoped strict TypeScript 5.9.3, exact source/dependency identity, offline isolation and final candidate cleanliness passed. Final scope is 382 additions across three new paths, under the 400-line cap; the old pin and legacy lanes remain unchanged. Native review consent was declined for this candidate, with no lineage or mutation; independent high-risk verification passed under ordinary policy. No questionnaire behavior or runtime execution.
- [x] **UQA-02 — Build a strict derived adaptation artifact.** Verified at `fc1a54c8aa3a2712ce9697026e11e802a78e3779`, CI 35552590669: acquisition and both strict TypeScript gates passed; all 10 composition tests, derived read-only verification and final cleanliness passed. Final scope is 485 changed lines across five paths, inside the user-approved 550-line exception; the general cap remains 400. Exact preimages/postimages, path inventory, standard Git application, offset/fuzz rejection, source immutability and failure output absence were exercised. Staging cleanup runs through awaited `finally` but lacks a separate directory-absence assertion. Native review consent was declined for this candidate, with no lineage or mutation; independent high-risk verification passed under ordinary policy. No questionnaire behavior or runtime execution.
- [x] **UQA-03 — Restore Herdr blocked-event compatibility.** Verified at `4052df260a731dc8a596e59ae8b9f45a2aa86a63`, CI 35556873719, after genuine RED at `8a701b8a4b9bb0123984c253c8b109365722213c`, CI 35555277959. Exact hosted GREEN: acquisition 2/2, zero-patch composition 10/10, strict producer/test types, upstream type ratchet with no regressions, three-patch composition/read-only checks, and 92/92 selected behavior tests passed. Native and compatibility events are private, ordered and balanced through answered/cancelled/thrown and guarded overlap. Final scope 383 additions plus one deletion across six paths, under 400; consumer/shared helper unchanged. Native START produced two fresh-but-expired consent envelopes with no invocation, lineage or mutation; independent high-risk verification passed.
- [x] **UQA-04a — Preserve partial cancellation results.** Verified RED `a5d49950d7ba2e4a7f2f7faf7227ece90f2dc906`, CI 35604269961, and GREEN `1009889ca53e8dfc442586d1f848e9d9ef9756ad`, CI 35606579713. Per explicit user decision, these are two bounded TDD work units with no size exception: RED 379 lines; GREEN incremental 76 lines. Exact GREEN passed 96/96 with committed option+preview, custom+MULTI and prior-answer retention, draft omission, unchanged empty cancellation, UQA-03 events/Herdr, type/composition/read-only and cleanliness gates. Cumulative behavior scope is 415 lines and is reported separately. Native high-risk review lineage `review-1ab1dd6b86f1527c` approved across four lenses and was acknowledged/burned. Notes remain UQA-06.
- [x] **UQA-04b — Settle abort and races exactly once.** User approved readability-safe RED work units A1 → A2 → B with no size exception after rejecting a code-golfed combined candidate. A1 `42939637c2c0a0312e139249e72e500961c1e8f2` is verified authored-only at 391 lines. A2 `1a7deb68fd8e631506b749485d88f139b0e76eda` is verified authored-only at 246 incremental lines with all eight readable abort/race contracts and unchanged prior gates. Exact standard-Git application/postimage and behavioral RED remain pending B. Initial B `44be140c0dc49e332892a1679a002a6809b1eca8` failed infrastructure because Docker stdin omitted `-i`; no abort composition or behavior ran. The hosted RED closed at `3ad033ef12d72b0894dc284bf6c76bf3e51527cc`, CI 35636241557, after bounded stdin and nullable-listener corrections. Exact composition/postimage `e0afc181256c503efa3fb3fd2fb54899abe4cc0c`, read-only isolation, strict types and ratchet passed; genuine RED was 97 top-level / 104 total / 96 pass / 8 fail. Evidence isolates ignored aborts: pre-abort mounted UI, mounted paths used fallback with listeners 0/0, deferred mount continued, and submit/cancel/rejection preserved outcomes but lacked listener lifecycle. Combined GREEN `29d18e8ab8dd42bc09266038b70a0514dd6949e8` plus scoped-compiler correction `85c333314f46f9123e2b45b97562bf99b02412df` is verified by CI 35643190033: all four exact postimages, read-only isolation, strict types, ratchet and 104/104 behavior passed; the separate RED lane still reproduces exactly eight failures. Producer `007` preserves `003` events and `005` partials while adding explicit listener cleanup and real view cancellation; view `008` delegates to guarded `finish`. Native review START twice returned fresh-but-expired consent bindings with no invocation, lineage or mutation. Read-only assessment classified the exact range high-risk/process-boundary with native review unavailable, requiring writer self-verification plus an independent verifier; both are satisfied by the static writer evidence and exact-SHA verification above.
- [x] **UQA-05 — Add explicit controls and MULTI semantics.** Explicit Submit changes six upstream view expectations and cumulative `006` input drivers, so full replacement patches exceed 400 lines. First add a separately tested `composition/v2` prerequisite: v1 remains byte-compatible, while v2 admits only contiguous same-target chains with source/step hash continuity, staged preimage checks, metadata-change rejection and real target ancestors. Hosted read-only patch mounts and single-process composition remain the bounded TOCTOU mitigation. Then use small deltas for RED controls/MULTI contracts and GREEN producer/view behavior, preserving UQA-04b artifacts and shared fullscreen interaction.
  Controls RED `7063d163`, CI 35666637946, verified the exact `009 → 010` chain and 23/20/3 contract. Final `f4836a36`, CI 35675663316, verifies corrected stale-MULTI RED 26/25/1 at the final deep comparison; mouse controls and failed-submit atomicity; correction GREEN ask/Herdr 105/105 and view 26/26; pre-correction 105/100/5 and view 23/23; strict types, ratchet, composition/read-only, pinned image and final cleanliness. UX CI 35675663273 passed all six jobs. Native high-risk review `review-624fe0fa34b8a369` approved all four lenses and was acknowledged/burned.
- [ ] **UQA-06 — Add question and global notes.** Preserve notes in successful and cancelled results with focused contract tests.
- [ ] **UQA-07 — Add configurable editor/navigation bindings.** Include disabled arrays, multiline editing and required external-editor behavior without replacing the shared interaction helper.
- [ ] **UQA-08 — Add dock viewport and preview behavior.** Height budgeting, narrow/short reachability, preview scrolling and resizing while retaining transcript scrolling.
- [ ] **UQA-09 — Add RPC presentation.** Select plus editor/input fallback, empty/custom/MULTI/notes/partial results and abort behavior.
- [ ] **UQA-10 — Verify adapted provider lifecycle.** Actual hosted protocol, package filtering, exactly one registration, provider context, reload without duplicate listeners and final cleanliness.
- [ ] **UQA-11 — Verify full package and human migration.** Isolated complete-main startup with scratch/descendant cleanup, then separately authorized Herder acceptance and reversible migration. No activation is implied by prior tasks.

## Workload and delivery

- Current rough envelope: 2,660–3,650 authored changed lines across coherent units; estimates become binding only when each task is forecast immediately before its first write.
- Each unit closes with its own Conventional Commit and exact hosted evidence. A native review candidate is a bounded work-unit commit or future PR slice, never the accumulated feature branch.
- Delivery strategy remains `ask-on-risk`; no PR chain strategy or PR delivery is authorized. The user requested the existing branch, so work stays there until a separate delivery decision.
- Stop and re-scope before writing if a unit cannot honestly fit 400 lines. Rollback removes that unit's patch/tests/artifact entry without deleting prior units or historical artifacts.

## Current next step

UQA-05 is active. Close the separately tested `composition/v2` prerequisite, then revise and run the controls/MULTI RED with chained deltas before any producer/view GREEN. Preserve UQA-04b artifacts and do not expand into notes, bindings, viewport, RPC or shared fullscreen interaction.
