# Published Gentle-Shell manual smoke — native OS evidence

**Status:** Native artifact-preflight unit only. No managed installer, real-user Apply, or Ready claim is enabled by this task.

**Scope:** User selected a fast manual, separate-home path before any real install. The Linux disposable run of published `gentle-pi@3.7.0` with Pi `0.85.1` and official core Engram `v2.1.0` completed first setup, returned a Pi RPC state response, and rendered an interactive TUI editor. It did not authenticate a model. Do not extrapolate to Darwin or Windows.

## This unit: native artifact preflight

- A fork draft PR runs on native `macos-latest` and `windows-latest` with `contents: read` only.
- Stage published `gentle-pi@3.7.0` and `@earendil-works/pi-coding-agent@0.85.1` tarballs using `npm pack --ignore-scripts`; verify their registry SRI, including Gentle-Shell's exact SHA-512 SRI: `sha512-SXBp9jIRnVIcOsLCW/Zw4XDTXxhViXNxrCZS7LyioB6kdRl99Ohojeaj+yIH5+K/ucwLlTlHYBz8zwue9aspNQ==`.
- Resolve official core Engram `v2.1.0` separately. Require the exact native OS/architecture asset, release API SHA-256 digest, pinned release digest, and matching row in the verified official `checksums.txt`; keep verified archives in runner-disposable scratch.
- This unit does not install or unpack packages, execute any lifecycle script, postinstall, setup, or launcher, access real user config, run a Go source build, or claim setup/RPC/TUI/Ready evidence. It is artifact-integrity evidence only; runtime smoke evidence belongs to a later unit.

## Runtime evidence reserved for a later unit

- Use a native macOS runner and a native Windows runner with fresh disposable HOME/config/npm/cache/agent directories and an empty project cwd. No global npm install, user config, real account credentials, or published-package lifecycle script may execute before inspection.
- Pin the exact published Gentle-Shell archive and verify registry SRI. Stage Pi from the registry in the disposable prefix with lifecycle scripts disabled, then run only the audited Gentle-Shell postinstall in that prefix. Verify the package-local Gentle AI binary and its pin before setup.
- Core Engram is distinct from the npm Gentle Engram package. Resolve an official core release and verify its release checksum and archive before staging the binary on scratch PATH. Never forward a GitHub token to Gentle-Shell, Gentle AI, npm, Pi, or Engram.
- Do not rely on the published launcher's peer `package.json` lookup: Pi `0.85.1` does not export that path. Point `GENTLE_SHELL_PI` at the exact scratch Pi executable and prove the child preflight sees only that scratch command.
- Run one fresh separate-home launch after preflight. Assert setup completed and Pi RPC initialized independently. A provisioning marker, version, command exit, or RPC state response alone does not establish interactive Ready. Native TUI evidence must be identified separately; report it unverified if a reliable PTY is unavailable.
- Windows needs a known Go `1.25.10+` source-build toolchain for the pinned package-local Gentle AI. Preserve necessary Windows system environment fields while scrubbing user configuration selectors. No Windows native proof may be inferred from Linux.

## Work-unit and authority boundary

Keep test script, workflow, and this record in reviewable units of at most 400 diff lines, with focused red/green checks where a behavior harness is added. Fail closed for unsafe paths, empty selectors, missing digests, or incomplete runtime evidence. Fork draft PRs may target pinned non-`main` bases for native CI; do not merge, auto-merge, push to `main`, publish, install globally, replace a preview, or touch the real Pi home without fresh exact user approval.

**Rollback:** Revert only this verification branch. The successful Linux scratch evidence and earlier failed scratch attempts are outside this branch and must be preserved.
