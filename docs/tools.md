# Tool reference

> Auto-generated from the running server (`node scripts/gen-tools.mjs`) — always in sync with the implementation.
> noracu v0.1.0 · 35 tools

## Mac layer (computer-use)

*cliclick · screencapture · JXA System Events*

| Tool | Arguments | Description |
|---|---|---|
| `mac_screenshot` | region:object? | Capture the Mac screen as PNG base64, optionally cropped to region {x,y,w,h}. Returns {scale, logical_size, screen:'main'} for the main display; click coordinates are in points (pixels / scale). |
| `mac_ax_state` | app:string?, depth:number? | Read the foreground app's accessibility tree (element index/role/title/value/frame; indexes feed mac_click/mac_drag for 30s); menu bar pruned by default (use mac_menu_command); optional app name and depth (default 3, clamped 1-10). Returns ax_empty if the app has no AX-visible window (not frontmost / another Space). |
| `mac_click` | x:number?, y:number?, element_index:integer?, button:string?, count:number? | Click at {x,y} or on a UI element, with optional button (left\|right\|middle) and count. Use element_index from the latest mac_ax_state (valid 30s); returns element_no_longer_valid when stale. |
| `mac_drag` | **from_index**:integer, **to_index**:integer | Drag from one UI element to another (move windows, sliders, selections). Use from_index/to_index from the latest mac_ax_state (valid 30s); returns element_no_longer_valid when stale. |
| `mac_scroll` | direction:string?, pages:number? | Scroll the frontmost window up/down/left/right by a number of pages (default 1); moves the pointer over that window first. |
| `mac_key` | key:string?, app:string? | Press a key or modifier chord, e.g. 'return', 'esc', 'cmd-c', 'cmd-shift-v', 'arrow-up'. Pass app to refuse input unless that app is frontmost (focus guard). |
| `mac_type` | text:string?, app:string? | Type text at the current focus without modifier keys. Pass app to refuse input unless that app is frontmost (focus guard). Not IME-safe: with a CJK input method active, keystrokes may be re-segmented — use mac_paste for reliable text entry. |
| `mac_paste` | text:string?, app:string? | Write text to the clipboard and paste it with Cmd+V. Pass app to refuse input unless that app is frontmost (focus guard). |
| `mac_menu_command` | app:string?, command:string? | Run an app's menu bar command via accessibility traversal (locale-safe). |

## Browser layer (browser-use)

*Playwright*

| Tool | Arguments | Description |
|---|---|---|
| `browser_launch` | headless:boolean? | Launch the browser with a persistent profile (headed by default; pass headless:true for headless). |
| `browser_navigate` | url:string? | Navigate the current tab to an http(s) URL. file:// is disabled unless NORACU_ALLOW_FILE_URL=1. |
| `browser_snapshot` | browser_id:string? | Return the page's ARIA accessibility snapshot plus a clickable element index list (indexes feed browser_click). |
| `browser_screenshot` | fullPage:boolean?, format:string?, quality:number?, clip:object? | Screenshot the page with optional fullPage, format png\|jpeg, quality (1-100, jpeg) and clip {x,y,width,height}; returns the image plus DPR/viewport metadata. |
| `browser_click` | element_index:integer?, selector:string?, xy:array?, button:string? | Click a page element, preferring element_index; selector is a fallback, xy pixel coordinates not recommended. Use element_index from the latest browser_snapshot (valid 30s); returns element_no_longer_valid when stale. |
| `browser_fill` | selector:string?, value:string? | Fill an input field matched by selector; fill replaces the whole value (browser_type appends keystrokes). |
| `browser_press_key` | key:string? | Press a key or chord, e.g. 'Enter' or 'Control+A'. |
| `browser_type` | text:string? | Type text via the keyboard into the focused element; type appends keystrokes (browser_fill replaces the whole value). |
| `browser_scroll` | direction:string?, pages:number? | Scroll the page up or down by a number of pages. |
| `browser_read` | selector:string? | Read the page's visible text, optionally scoped to a selector. |
| `browser_evaluate` | js:string? | Evaluate JavaScript in the page and return the result. |
| `browser_close` | — | Close the browser. |

## iPhone layer (device-use)

*imctl / iPhone Mirroring*

| Tool | Arguments | Description |
|---|---|---|
| `phone_status` | — | EXPERIMENTAL. Requires imctl (not yet public). Return the iPhone Mirroring session status as JSON. |
| `phone_launch` | — | EXPERIMENTAL. Requires imctl (not yet public). Ensure iPhone Mirroring is running and brought to the front. |
| `phone_screenshot` | — | EXPERIMENTAL. Requires imctl (not yet public). Screenshot the iPhone screen (the Mirroring window region). |
| `phone_ocr` | — | EXPERIMENTAL. Requires imctl (not yet public). OCR the iPhone screen into text with coordinates. |
| `phone_find` | text:string? | EXPERIMENTAL. Requires imctl (not yet public). Locate text on the iPhone screen. |
| `phone_tap` | x:number?, y:number? | EXPERIMENTAL. Requires imctl (not yet public). Tap at {x, y} in normalized 0-1 coordinates. |
| `phone_longpress` | x:number?, y:number?, duration:number? | EXPERIMENTAL. Requires imctl (not yet public). Long-press at {x, y} for an optional duration in seconds. |
| `phone_swipe` | from:array?, to:array?, ms:number? | EXPERIMENTAL. Requires imctl (not yet public). Swipe from [x,y] to [x,y] over an optional duration in ms. |
| `phone_home` | — | EXPERIMENTAL. Go to the iPhone Home Screen via the iPhone Mirroring menu (works without imctl when the mirror is connected); falls back to an imctl swipe. |
| `phone_app_switcher` | — | EXPERIMENTAL. Open the iPhone App Switcher via the iPhone Mirroring menu (works without imctl when the mirror is connected); falls back to an imctl gesture. |
| `phone_scroll` | direction:string?, distance:number? | EXPERIMENTAL. Requires imctl (not yet public). Scroll up or down by a distance. |
| `phone_type` | text:string? | EXPERIMENTAL. Requires imctl (not yet public). Type text via the clipboard (IME-safe). |
| `phone_key` | key:string? | EXPERIMENTAL. Requires imctl (not yet public). Press a key: return, delete, up, down, left, or right. |
| `phone_open` | app:string? | EXPERIMENTAL. Requires imctl (not yet public). Open an app via Spotlight search plus OCR-guided tap. |

