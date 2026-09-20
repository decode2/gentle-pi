# Questionnaire composition with pinned main

Validate the owned questionnaire alongside the real, immutable main package before proposing reversible replacement of external rpiv. Isolated questionnaire success does not establish full-package compatibility.

## Identity and authorization

- Repository: decode2/gentle-pi. The former canonical URL Gentleman-Programming/gentle-pi redirects to Gentleman-Programming/gentle-shell (verified through GitHub repository metadata).
- Worktree: questionnaire-visual-polish-5594c1f4; branch: test/questionnaire-visual-polish-5594c1f4.
- Feature baseline: `14d7b7cd7a956ac7011c124464d82cd5ae0da15a`.
- Route: ODD, delegated direct; no SDD or new branches. Parent owns reconciliation.
- This document reconstructs verified progress; it does not claim earlier complete ODD compliance.
- User authorized tracking reconciliation and isolated hosted composition work. Normal activation, lab retargeting, uninstall, PR creation, main push/merge and auto-merge remain unauthorized.

## Constraints and checks

- One writer; preserve protected worktrees, lab results, quarantine and unrelated work.
- No local tests, Node/SDK execution, compilers, parsers, builds, installs, formatters or Docker. Source/Git inspection is allowed; execution evidence must come from exact-SHA hosted CI.
- TDD is active by retained explicit session/user choice. Observe hosted RED before production behavior changes, then GREEN and refactor. Characterizing unchanged behavior does not require fabricating RED. Fixture/infrastructure failures are not production defects.
- Existing runner: `.github/workflows/questionnaire-ux-validation.yml`; isolated container runs `/usr/local/bin/node --experimental-strip-types --test /workspace/tests/hosted-ask-user-question-rpc.test.ts`. Preserve its scoped TypeScript check and ten existing OS suites.
- Runtime: network none, read-only root and source mounts, UID 1000, zero capabilities, no-new-privileges, clean environment, bounded temporary storage/resources and no credentials. Only separate isolated acquisition may use networking; scripts disabled.
- Preserve all 27 hosted tests. Keep catalog, active tools, provider context and source provenance distinct. Command-only negative probes do not observe provider Context.tools.
- Use complete pinned main, not the old candidate package as main. Do not silently replace main package/lock files, non-questionnaire extensions or shared native modules. Determine compatibility before choosing a composition layout.
- User-specific hard limit: 400 additions plus deletions per work unit, without line-golfing. General ODD size guidance is advisory; this explicit session constraint is stricter.
- Delivery strategy: `ask-on-risk`; retain same-branch work-unit commits under existing user authorization, with no PR delivery authorized. Chain strategy is unresolved and must be resolved before any PR preparation. The initial 190-line composition forecast is withdrawn. QMC-02a actual scope: 413 source/test/workflow lines plus 58 document lines, 471 additions total. User explicitly approved the 471-line unit, then up to 50 additional changed lines for the npm correction and ODD tracking below; neither exception changes the general 400-line limit. Native acquisition is deferred to QMC-02b. Later composition/startup scope remains unestimated; reforecast before its implementation. No new PR or branch strategy is authorized.

## Verified baseline

| Scope | Exact candidate and evidence | Outcome |
| --- | --- | --- |
| Package loading/filtering | `d0530ae5cc7b18a8797c44da0c477fa0f1b20fd4`, CI 35463668728 | 269 per OS, scoped TS, 25 hosted; external-only, candidate-only and filtered external passed; both provider requests receive only questionnaire |
| Negative owner admission | `14d7b7cd7a956ac7011c124464d82cd5ae0da15a`, CI 35465477625 | 269 per OS, scoped TS, 27 hosted; missing and legacy owner deny registration/activation; provider not called; final checks follow stdio close |
| Native authority | Negative-owner unit assessed high, base `d0530ae5cc7b18a8797c44da0c477fa0f1b20fd4`, 245 changed lines | Independent verification passed; native review outcome unknown, not approved |

Prior schema, parity, reload and positive owner coverage remains passing within the 27-test baseline. This is neither complete parity nor human TUI acceptance.

## Tasks and acceptance

- [x] **QMC-00 — Reconcile ODD tracking.** Inline parent, mechanical tracking reconciliation. Document and complete Engram mirror at `odd/questionnaire-main-composition/tasks` (observation 16662) written and read back; session todo projection established. Keep all three synchronized on transitions.
- [ ] **QMC-01 — Pin and inspect canonical main.** Partially verified; waiting for later startup mapping, not blocking acquisition-only work. Delegated read-only mapper: four-plus-file/dependency mapping trigger. Resolve main freshly, retrieve relevant source at its full SHA, inspect manifest/lock/shared interfaces and startup side effects. Produce a safe acquisition/composition plan and narrow edit surfaces. Parent freshly resolved main through `git ls-remote` to `43269de359c5052d2cadb72ab4cf2d57ca0211b0`. Exact-SHA GitHub source confirms package `gentle-pi@3.3.0`, Pi/TUI 0.85.1, pi-pretty 0.6.27, and no questionnaire entry in the extensions directory. Lockfile confirms Pi/TUI 0.85.1, typebox 1.1.38, TS 5.9.3 and Node types 24.13.3. Shared symbols exist; main agent-home additionally exports gentlePiConfigHome, so copying the old shared file would break main. No lib/questions collision. Full tool inventory, full startup side effects and runtime compatibility remain unproven. Discard stale local c7fd2e2 as a base.
- [ ] **QMC-02 — Implement isolated full-main composition.** One delegated writer: multi-file implementation trigger. Start only after QMC-01 resolves source/layout. Preserve main-owned shared code and all baseline checks; prove actual full-package registration/provenance separately from questionnaire execution. Pin acquisition, preserve isolation and record exact-SHA hosted results. Line forecast pending QMC-01; split acquisition from composition if necessary rather than compressing code.
- [ ] **QMC-02a — Acquire immutable main and JavaScript dependencies.** In progress; bounded correction delegated after CI bootstrap failure. Use standard Git acquisition and verify commit/tree plus unchanged tracked sources and frozen-lock dependencies with scripts disabled. Run artifact assertions in hosted network-none/read-only isolation; preserve existing 27 hosted tests. No native acquisition, Pi/native execution or overlay in this unit. Exact allowed source surfaces: workflow, new acquisition manifest and new acquisition test; parent alone maintains this document.
- [ ] **QMC-02b — Acquire the pinned native binary.** Deferred to a separate bounded unit, using the pins below. Verify archive before extraction, executable digest and canonical integrity manifest. No fake CLI, ambient binary or execution.
- [ ] **QMC-03 — Verify composition and native review.** Hosted external verification delegated independently; record counts and reached assertions. Assess the exact bounded work-unit candidate and follow native inspect/consent/review routes. No inferred receipt or approval; historical CI does not close native authority. Determine review scope before starting, not the accumulated feature branch.
- [ ] **QMC-04 — Human Herder/TUI acceptance.** Blocked on separate authorization to update the frozen lab. Preserve vertical UX; exercise real interaction, preview, notes, editor bindings and cancellation. Hosted RPC does not satisfy this task.
- [ ] **QMC-05 — Reversible migration plan.** Plan package filtering, ownership, compatibility and rollback from verified evidence. Any normal activation, settings change or external uninstall needs separate explicit authorization; planning is not permission to perform it.

No task above is checked off merely because a worker reports source completion. Composition execution (QMC-02) and review (QMC-03) remain unstarted; acquisition-only QMC-02a is separate and cannot establish full-main acceptance. Migration side-effect experiments and additional hosted TUI infrastructure are not silently added to this unit.

## Acquisition provenance and next step

- Candidate `4f057752b96fcfcddb5f165cc4d0c4710d6865e0`, CI 35481408331: 269 tests per OS, scoped TS and 27 RPC tests passed; npm bootstrap exited 1 with suppressed output, so all three offline artifact tests were unexecuted. No full-main or native approval claim.
- Exact Node v24.21.0 source bundles npm 11.19.0; its loader rejects identical user/global config paths. This supports the `/dev/null` collision diagnosis but does not recover the discarded runtime exception. Authorized correction: distinct private config paths and bounded bootstrap diagnostics with failure preserved; no speculative pnpm flag changes. Native START consent previously expired without a lineage or mutation; a future attempt requires fresh consent, not replay.

- Parent verified Git commit `43269de359c5052d2cadb72ab4cf2d57ca0211b0` and tree `f95764d4eff06e34223171b26a9d5493f206bab4` through the exact commit API. Do not invent a source-archive checksum or treat a newly computed digest as independent authenticity.
- Pinned main installer requires real Gentle AI 3.4.0. Linux amd64 archive: `https://github.com/Gentleman-Programming/gentle-ai/releases/download/v3.4.0/gentle-ai_3.4.0_linux_amd64.tar.gz`.
- Archive SHA-256: `c287289a514420381e890991bb3fbea4a2c36d7b4b1774fcf6bc4deb83378915`; executable SHA-256: `309d9aafb48de5ef90ba0a212e8a98e8fdbb82d0852e24015e36a5ce0fe04c06` (verified source pins, release bytes not yet acquired).
- Runtime location: `.gentle-ai/v3.4.0/gentle-ai`, adjacent `integrity.json`; compact JSON plus newline with ordered keys version, asset, assetSha256, binarySha256. Verify exact runtime source contract during implementation; no native execution in this unit.
- Parent rejected the unpublished 399-line combined draft: custom TAR parsing and compressed multi-statement lines were not an acceptable way to fit the budget; two JSON.parse inputs also lacked UTF-8 decoding. No hosted execution or publication occurred. Corrective worker splits source/dependency acquisition from native acquisition and replaces custom source extraction with standard Git. Preserve required assertions for each retained behavior; native assertions move with the deferred native unit.
- Separate networked acquisition from network-none artifact assertions. Later composition adds only `extensions/ask-user-question.ts` and `lib/questions/**`, with collision refusal, preserving main package/lock/shared modules and every existing extension.
- Native startup and remaining extensions' scratch/network behavior require further mapping before full-package execution. A missing binary may degrade gracefully but does not prove healthy startup. Do not stub the CLI or use ambient overrides.
- Existing todo #46 remains the historical umbrella; #28 maps to QMC-04 and #47 to QMC-05. QMC-02a is the next bounded implementation. Record actual changed lines, exact CI evidence and native tier/outcome before marking it complete. Rollback scope is the new acquisition lane/manifest/test and its task status, not the existing 27-test lane or unrelated code.
