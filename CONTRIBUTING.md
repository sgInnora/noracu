# Contributing

## Setup

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

## Reporting issues

Use the bug report template. For security vulnerabilities, use
[GitHub Security Advisory](https://github.com/sgInnora/noracu/security/advisories/new),
not a public issue.
