# Security Policy

noracu gives an MCP client control over your **real machine** — mouse,
keyboard, clipboard, browser, and (via iPhone Mirroring) your phone.
Treat every tool call as privileged.

## Threat model

| # | Threat | Vector | Status | Mitigation / notes |
|---|---|---|---|---|
| 1 | **Prompt injection → arbitrary code execution** | Observed content (web page text, AX tree titles, OCR output) contains instructions that trick the agent into calling tools with malicious arguments | **Mitigated for JXA** | `mac_ax_state` / `mac_menu_command` use static scripts + `osascript` argv — string parameters are data, never script source; the one numeric parameter (AX read depth) is clamped before use (regression-tested in `test/e2e.mjs`) |
| 2 | **Arbitrary local control** | `mac_click` / `mac_type` / `mac_paste` can operate password managers, banking pages, terminals | **Inherent** | Use client-side confirmation gates for high-stakes targets; see recommendations below. Optional `app` focus guard on `mac_type` / `mac_paste` / `mac_key` refuses input when another app is frontmost; `element_index` clicks additionally refuse (`element_no_longer_valid`) if the frontmost app changed since the snapshot the index came from. |
| 3 | **Arbitrary JS in browser** | `browser_evaluate` executes any JavaScript in the page context | **Mitigated (kill switch)** | Set `NORACU_DISABLE_EVAL=1`; `browser_evaluate` then returns an error on every call (it stays listed in `tools/list`) |
| 4 | **Input validation gaps** | Malformed arguments (NaN coordinates, oversized strings, `javascript:` URLs) | **Mitigated** | `validateArgs` runs on every tool call; tools with coordinate/enum/length/URL constraints are checked (others pass through) |
| 5 | **Screenshot privacy** | `mac_screenshot` / `phone_screenshot` capture the full screen / phone display | **Inherent** | Run in a dedicated macOS user account or virtual display for untrusted automation |
| 6 | **iPhone operations** | `phone_tap` / `phone_type` can interact with payment and SMS-verification UIs | **Inherent** | Consider disconnecting Apple Pay / keeping Mirroring off for untrusted sessions |
| 7 | **Supply chain** | malicious PRs / dependency poisoning after open-sourcing | **Partially mitigated** | Review all PRs touching `src/server.mjs` argument handling; lockfile committed; no `postinstall` scripts; the only runtime download is the one-time Playwright `chromium` install triggered by `browser_launch`, which can be disabled with `NORACU_DISABLE_AUTO_INSTALL=1` |
| 8 | **Local file read via browser** | `browser_navigate` to a `file://` URL, then `browser_read` exfiltrates local files | **Mitigated (default)** | `file://` blocked at the `browser_navigate` argument unless `NORACU_ALLOW_FILE_URL=1` (initial URL only; redirects fall under threat 9) |
| 9 | **HTTP GET side effects** | navigation triggers logout links, one-time tokens, private-network / cloud-metadata endpoints | **Not mitigated** | No URL blocklist (redirects and DNS rebinding defeat pre-navigation checks); client-side policy |
| 10 | **Clipboard clobbering by mac_paste** | `mac_paste` overwrites the clipboard with the pasted text | **Partially mitigated** | Previous text content is restored after ~150ms; non-text clipboard contents are lost; async paste targets may race |
| 11 | **Untrusted observation content** | ARIA snapshots, AX trees, OCR, page text contain attacker-controlled text | **Not mitigated** | The MCP client must treat tool results as data, never as instructions |

## Hardening recommendations

- Set `NORACU_DISABLE_EVAL=1` unless you actively need `browser_evaluate`.
- Gate `mac_type` / `mac_paste` behind human confirmation when the frontmost
  app is a password manager or banking site (client-side policy).
- Run untrusted automation in a dedicated macOS user account with
  Accessibility + Screen Recording granted only to that account's client.
- Audit tool calls in your MCP client's log — every action is visible there.
- The persistent browser profile at `~/.noracu/browser-profile` keeps cookies
  across sessions — clear it between untrusted runs.
- `NORACU_READ_ONLY=1` does not block the one-time `playwright install
  chromium` download triggered by `browser_launch`; set
  `NORACU_DISABLE_AUTO_INSTALL=1` to require a manual install instead.

## Reporting a vulnerability

Please report security issues privately through a GitHub Security Advisory
(repo → **Security** → **Advisories** → **Report a vulnerability**). Do not
open public issues for exploitable bugs. We aim to respond within 72 hours.
