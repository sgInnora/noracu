# Contributing

## Reporting a problem (no clone needed)

The most useful contribution is a report with the tool name and the steps. Two forms ask for what is needed:
[a bug](https://github.com/sgInnora/noracu/issues/new?template=bug.yml), or [an app or site that noracu reads or operates badly](https://github.com/sgInnora/noracu/issues/new?template=app-report.yml). `mac_status` gives the noracu and
macOS versions the forms ask for. For security vulnerabilities, use a
[GitHub Security Advisory](https://github.com/sgInnora/noracu/security/advisories/new), not a public issue.

## Setup

For changing the code:

```bash
git clone https://github.com/sgInnora/noracu.git
cd noracu
npm install
npm test
```

`npm test` runs the e2e suite. On macOS with Accessibility and Screen
Recording permissions granted to your terminal, all checks run; prefix with
`NORACU_CI=1` to skip hardware-dependent checks.

## Rules

- **`docs/tools.md` is generated** — never edit it by hand. After changing any
  tool name, arguments, or description in `src/server.mjs`, run
  `node scripts/gen-tools.mjs` and commit the result. CI fails on a stale
  `tools.md`.
- **Documentation is English** — README, `docs/`, commit messages, and tool
  descriptions in `src/server.mjs` (they are consumed by LLM clients).
- Keep changes minimal and focused: one concern per PR.
