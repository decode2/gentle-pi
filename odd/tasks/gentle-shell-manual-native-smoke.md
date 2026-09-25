# Published Gentle-Shell manual smoke — native OS evidence

**Status:** Native artifact preflight and npm install smoke only; installed package bytes remain unverified. No package postinstall, Gentle AI install, setup, launcher, Pi RPC/TUI, or Ready claim is enabled by this unit.

**Scope:** User selected a fast manual, separate-home path before any real install. The Linux disposable run of published `gentle-pi@3.7.0` with Pi `0.85.1` and official core Engram `v2.1.0` completed first setup, returned a Pi RPC state response, and rendered an interactive TUI editor. It did not authenticate a model. Do not extrapolate to Darwin or Windows.

## Prior unit: native artifact preflight

- A fork draft PR runs on native `macos-latest` and `windows-latest` with `contents: read` only.
- Stage published `gentle-pi@3.7.0` and `@earendil-works/pi-coding-agent@0.85.1` tarballs using `npm pack --ignore-scripts`; verify their registry SRI, including Gentle-Shell's exact SHA-512 SRI: `sha512-SXBp9jIRnVIcOsLCW/Zw4XDTXxhViXNxrCZS7LyioB6kdRl99Ohojeaj+yIH5+K/ucwLlTlHYBz8zwue9aspNQ==`.
- Resolve official core Engram `v2.1.0` separately. Require the exact native OS/architecture asset, release API SHA-256 digest, pinned release digest, and matching row in the verified official `checksums.txt`; keep verified archives in runner-disposable scratch.
- This unit does not install or unpack packages, execute any lifecycle script, postinstall, setup, or launcher, access real user config, run a Go source build, or claim setup/RPC/TUI/Ready evidence. It is artifact-integrity evidence only; runtime smoke evidence belongs to a later unit.

## This unit: isolated native npm install smoke only

- After artifact preflight passes, create owner-only runner-disposable scratch with real non-symlink ancestors, bounded-reverify both staged archive SRIs, and invoke the exact npm CLI bundled beside setup-node's `process.execPath`. Use only the two staged archives as package inputs, `--ignore-scripts`, the isolated prefix/config/cache/temp, and an allowlisted environment; never forward host PATH, credentials, or NODE_OPTIONS. Suppress npm output and report a fixed failure category.
- Success means only `npm install` returned zero. The staged paths can change between SRI verification and npm reopening them; installed bytes are unverified. Do not extract archives, read installed manifests or locks, claim package-content identity, execute lifecycle/postinstall, set up Go, execute a binary, run setup/launcher/Pi RPC/TUI, or claim Ready.
- Focused tests establish RED before GREEN for Node/npm CLI layout selection, missing/symlinked/oversized scratch inputs, exact arguments, and environment isolation. Native CI receipts remain pending.
- Rollback: revert only this npm-smoke workflow/script/tests and this unit's record text; preserve the preceding artifact-preflight unit and receipts.

## Next unit: verify installed package bytes before postinstall

- In a separate bounded unit, verify every executable and imported file in the installed package against an immutable verified archive buffer, with bounded reads and real non-symlink ancestor checks. Only then may a later authorized scope execute postinstall and verify native Gentle AI provenance.
- Add independent RED/GREEN tests and stay below 400 diff lines. No package postinstall, Go, binary, setup, launcher, Pi RPC/TUI, or Ready evidence is part of this npm-smoke unit.

## Runtime evidence reserved for a later unit

- Use a native macOS runner and a native Windows runner with fresh disposable HOME/config/npm/cache/agent directories and an empty project cwd. No global npm install, user config, real account credentials, or published-package lifecycle script may execute before inspection.
- Pin the exact published Gentle-Shell archive and verify registry SRI. Before any postinstall, verify every installed executable/imported file against an immutable verified archive buffer with bounded reads and symlink-ancestor refusal. Only a separately reviewed later unit may then run the audited Gentle-Shell postinstall in the disposable prefix and verify the package-local Gentle AI binary and its pin before setup.
- Core Engram is distinct from the npm Gentle Engram package. Resolve an official core release and verify its release checksum and archive before staging the binary on scratch PATH. Never forward a GitHub token to Gentle-Shell, Gentle AI, npm, Pi, or Engram.
- Do not rely on the published launcher's peer `package.json` lookup: Pi `0.85.1` does not export that path. Point `GENTLE_SHELL_PI` at the exact scratch Pi executable and prove the child preflight sees only that scratch command.
- Run one fresh separate-home launch after preflight. Assert setup completed and Pi RPC initialized independently. A provisioning marker, version, command exit, or RPC state response alone does not establish interactive Ready. Native TUI evidence must be identified separately; report it unverified if a reliable PTY is unavailable.
- Windows needs a known Go `1.25.10+` source-build toolchain for the pinned package-local Gentle AI. Preserve necessary Windows system environment fields while scrubbing user configuration selectors. No Windows native proof may be inferred from Linux.

## Work-unit and authority boundary

Keep test script, workflow, and this record in reviewable units of at most 400 diff lines, with focused red/green checks where a behavior harness is added. Fail closed for unsafe paths, empty selectors, missing digests, or incomplete runtime evidence. Fork draft PRs may target pinned non-`main` bases for native CI; do not merge, auto-merge, push to `main`, publish, install globally, replace a preview, or touch the real Pi home without fresh exact user approval.

**Rollback:** Revert only this verification branch. The successful Linux scratch evidence and earlier failed scratch attempts are outside this branch and must be preserved.
