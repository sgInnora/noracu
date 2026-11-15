// SPDX-License-Identifier: MIT
// RunnerCommands.swift — protocol v1 command implementations (snapshot, gestures, typing).
// All entry points run on the main thread. MIT licensed, see LICENSE.

import XCTest
import Foundation

enum RunnerCommands {
    // MARK: helpers

    static func fail(_ id: Int, _ error: String, _ message: String, sent: Any? = nil) -> [String: Any] {
        var r: [String: Any] = ["id": id, "ok": false, "error": error, "message": message]
        if let sent { r["sent"] = sent }
        return r
    }

    static func ok(_ id: Int, _ result: [String: Any]) -> [String: Any] {
        ["id": id, "ok": true, "result": result]
    }

    static let bundleIdRegex = "^[A-Za-z0-9][A-Za-z0-9.-]{0,154}$"

    static func validBundleId(_ s: String) -> Bool {
        s.range(of: bundleIdRegex, options: .regularExpression) != nil
    }

    static func screen() -> CGRect { XCUIApplication(bundleIdentifier: "com.apple.springboard").frame }

    static func app(_ bundleId: String) -> XCUIApplication {
        XCUIApplication(bundleIdentifier: bundleId)
    }

    static func msSince(_ t0: Date) -> Int { Int(Date().timeIntervalSince(t0) * 1000) }

    static let inputOps: Set<String> = ["tap", "press", "drag", "type", "keys", "home"]

    static func isBool(_ v: Any) -> Bool { CFGetTypeID(v as CFTypeRef) == CFBooleanGetTypeID() }

    // a number field; a JSON true / false is not a number
    static func num(_ v: Any?) -> Double? {
        guard let v, !isBool(v) else { return nil }
        return v as? Double
    }

    // an optional whole-number field: absent → the default; present but not a whole number in range → nil,
    // and the caller refuses the command (a field of the wrong type is never read as "not given")
    static func optInt(_ args: [String: Any], _ key: String, _ range: ClosedRange<Int>, _ dflt: Int) -> Int? {
        guard let raw = args[key] else { return dflt }
        guard !isBool(raw), let v = raw as? Int, range.contains(v) else { return nil }
        return v
    }

    // MARK: dispatch

    @MainActor
    static func dispatch(op: String, args: [String: Any], box: RunnerBox) -> [String: Any] {
        let id = 0 // id is re-attached by the server wrapper below
        switch op {
        case "ping":
            return ok(id, ["v": 1, "uptime_ms": msSince(box.started), "served": box.served])
        case "app_state":
            return appState(args)
        case "snapshot":
            return snapshot(args)
        case "tap":
            return input(args) { a, x, y in tapCmd(a, x, y, args) }
        case "press":
            return input(args, press: true) { a, x, y in pressCmd(a, x, y, args) }
        case "drag":
            return dragCmd(args)
        case "type":
            return textCmd(args) { a in typeCmd(a, args) }
        case "keys":
            return textCmd(args) { a in keysCmd(a, args) }
        case "home":
            let t0 = Date()
            XCUIDevice.shared.press(.home)
            return ok(0, ["ms": msSince(t0)])
        case "screenshot":
            return screenshotCmd()
        case "front":
            return frontCmd()
        case "selftest_issue":
            // test hook, answered only when the runner was started with NORACU_SELFTEST=1
            guard box.selftest else { return fail(0, "unknown_op", "unknown op \(op)") }
            if (args["late"] as? Bool) == true {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { XCTFail("noracu selftest late issue") }
                return ok(0, [:])
            }
            XCTFail("noracu selftest issue")
            return ok(0, [:])
        case "quit":
            box.done = true
            return ok(0, [:])
        default:
            return fail(0, "unknown_op", "unknown op \(op)")
        }
    }

    // MARK: app_state

    @MainActor
    static func appState(_ args: [String: Any]) -> [String: Any] {
        guard let bundle = args["bundle_id"] as? String, validBundleId(bundle) else {
            return fail(0, "invalid_args", "bad bundle_id")
        }
        let a = app(bundle)
        let raw = a.state.rawValue
        let name: String
        switch a.state {
        case .unknown: name = "unknown"
        case .notRunning: name = "notRunning"
        case .runningBackgroundSuspended: name = "runningBackgroundSuspended"
        case .runningBackground: name = "runningBackground"
        case .runningForeground: name = "runningForeground"
        @unknown default: name = "unknown"
        }
        return ok(0, ["state": raw, "name": name])
    }

    // MARK: text-command gate (type / keys: no coordinates)

    @MainActor
    static func textCmd(_ args: [String: Any], _ body: (XCUIApplication) -> [String: Any]) -> [String: Any] {
        guard let bundle = args["bundle_id"] as? String, validBundleId(bundle) else {
            return fail(0, "invalid_args", "bad bundle_id", sent: false)
        }
        let a = app(bundle)
        let st = a.state
        if st == .notRunning || st == .unknown {
            return fail(0, "app_not_running", "state \(st.rawValue)", sent: false)
        }
        if bundle != "com.apple.springboard" && st != .runningForeground {
            return fail(0, "app_not_foreground", "state \(st.rawValue)", sent: false)
        }
        if bundle == "com.apple.springboard", let no = springboardRefusal(args, .text) { return no }
        if bundle != "com.apple.springboard", let no = alertRefusal() { return no }
        return body(a)
    }

    // MARK: events without XCTest's idle wait

    // XCTest waits for the app to go idle before and after each synthesized event. An app that never does held a tap
    // past noracu's 20 s limit unsent: the context menu of a long-pressed note in Notes (iPhone 16 Pro, iOS 27.2.1,
    // device run 2026-11-14). Taps, presses and drags go out without that wait, through XCUIApplication's
    // _performWithInteractionOptions:block: with SkipPreEventQuiescence | SkipPostEventQuiescence (bits 0 and 1, as
    // XCUIAutomation's own shouldSkip…Quiescence read them). Where that method is missing the event goes out the usual
    // way. noracu reports these inputs as unverified and reads the screen again before relying on what they did.
    @MainActor
    static func withoutIdleWait(_ a: XCUIApplication, _ body: @escaping () -> Void) {
        let sel = NSSelectorFromString("_performWithInteractionOptions:block:")
        guard a.responds(to: sel), let m = class_getInstanceMethod(type(of: a), sel) else { body(); return }
        typealias Perform = @convention(c) (AnyObject, Selector, UInt, @convention(block) () -> Void) -> Void
        let perform = unsafeBitCast(method_getImplementation(m), to: Perform.self)
        perform(a, sel, 0b11, body)
    }

    // MARK: input-command gate

    @MainActor
    static func input(_ args: [String: Any], press: Bool = false, _ body: (XCUIApplication, CGFloat, CGFloat) -> [String: Any]) -> [String: Any] {
        guard let bundle = args["bundle_id"] as? String, validBundleId(bundle) else {
            return fail(0, "invalid_args", "bad bundle_id", sent: false)
        }
        guard let x = num(args["x"]), let y = num(args["y"]) else {
            return fail(0, "invalid_args", "x/y required", sent: false)
        }
        let scr = screen()
        guard x >= 0, y >= 0, x <= scr.width, y <= scr.height else {
            return fail(0, "invalid_args", "point outside screen", sent: false)
        }
        let a = app(bundle)
        let st = a.state
        if st == .notRunning || st == .unknown {
            return fail(0, "app_not_running", "state \(st.rawValue)", sent: false)
        }
        if bundle != "com.apple.springboard" && st != .runningForeground {
            return fail(0, "app_not_foreground", "state \(st.rawValue)", sent: false)
        }
        if bundle == "com.apple.springboard", let no = springboardRefusal(args, press ? .press : .tap, at: CGPoint(x: x, y: y)) { return no }
        if bundle != "com.apple.springboard", let no = alertRefusal() { return no }
        return body(a, CGFloat(x), CGFloat(y))
    }

    @MainActor
    static func tapCmd(_ a: XCUIApplication, _ x: CGFloat, _ y: CGFloat, _ args: [String: Any]) -> [String: Any] {
        guard let count = optInt(args, "count", 1...3, 1) else { return fail(0, "invalid_args", "count must be a whole number 1–3", sent: false) }
        let t0 = Date()
        let coord = a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
        withoutIdleWait(a) {
            if count == 2 {
                coord.doubleTap()
            } else if count == 3 {
                for _ in 0..<3 { coord.tap() }
            } else {
                coord.tap()
            }
        }
        return ok(0, ["ms": msSince(t0)])
    }

    @MainActor
    static func pressCmd(_ a: XCUIApplication, _ x: CGFloat, _ y: CGFloat, _ args: [String: Any]) -> [String: Any] {
        guard let rawD = args["duration_ms"], !isBool(rawD), let d = rawD as? Int, (100...5000).contains(d) else {
            return fail(0, "invalid_args", "duration_ms out of range", sent: false)
        }
        let t0 = Date()
        let coord = a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: x, dy: y))
        withoutIdleWait(a) { coord.press(forDuration: TimeInterval(d) / 1000.0) }
        return ok(0, ["ms": msSince(t0)])
    }

    @MainActor
    static func dragCmd(_ args: [String: Any]) -> [String: Any] {
        guard let bundle = args["bundle_id"] as? String, validBundleId(bundle) else {
            return fail(0, "invalid_args", "bad bundle_id", sent: false)
        }
        guard let from = args["from"] as? [Any], from.count == 2,
              let fx = num(from[0]), let fy = num(from[1]),
              let to = args["to"] as? [Any], to.count == 2,
              let tx = num(to[0]), let ty = num(to[1]) else {
            return fail(0, "invalid_args", "from/to required", sent: false)
        }
        guard let holdMs = optInt(args, "hold_ms", 0...2000, 50) else { return fail(0, "invalid_args", "hold_ms must be a whole number 0–2000", sent: false) }
        guard let endHoldMs = optInt(args, "end_hold_ms", 0...2000, 300) else { return fail(0, "invalid_args", "end_hold_ms must be a whole number 0–2000", sent: false) }
        var velocity: XCUIGestureVelocity = .slow
        if let raw = args["velocity"] {
            switch raw as? String {
            case "slow": velocity = .slow
            case "default": velocity = .default
            case "fast": velocity = .fast
            default: return fail(0, "invalid_args", "bad velocity", sent: false)
            }
        }
        let scr = screen()
        for p in [CGPoint(x: fx, y: fy), CGPoint(x: tx, y: ty)] {
            guard p.x >= 0, p.y >= 0, p.x <= scr.width, p.y <= scr.height else {
                return fail(0, "invalid_args", "point outside screen", sent: false)
            }
        }
        let a = app(bundle)
        let st = a.state
        if st == .notRunning || st == .unknown {
            return fail(0, "app_not_running", "state \(st.rawValue)", sent: false)
        }
        if bundle != "com.apple.springboard" && st != .runningForeground {
            return fail(0, "app_not_foreground", "state \(st.rawValue)", sent: false)
        }
        if bundle == "com.apple.springboard", let no = springboardRefusal(args, .drag) { return no }
        if bundle != "com.apple.springboard", let no = alertRefusal() { return no }
        let t0 = Date()
        let fromC = a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: fx, dy: fy))
        let toC = a.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: tx, dy: ty))
        withoutIdleWait(a) {
            fromC.press(forDuration: TimeInterval(holdMs) / 1000.0, thenDragTo: toC, withVelocity: velocity, thenHoldForDuration: TimeInterval(endHoldMs) / 1000.0)
        }
        return ok(0, ["ms": msSince(t0)])
    }

    @MainActor
    static func typeCmd(_ a: XCUIApplication, _ args: [String: Any]) -> [String: Any] {
        guard let text = args["text"] as? String, (1...2000).contains(text.count) else {
            return fail(0, "invalid_args", "text out of range", sent: false)
        }
        guard a.keyboards.firstMatch.exists else {
            return fail(0, "no_keyboard", "no keyboard", sent: false)
        }
        let t0 = Date()
        a.typeText(text)
        return ok(0, ["ms": msSince(t0)])
    }

    @MainActor
    static func keysCmd(_ a: XCUIApplication, _ args: [String: Any]) -> [String: Any] {
        guard let key = args["key"] as? String, key == "delete" || key == "return" else {
            return fail(0, "invalid_args", "bad key", sent: false)
        }
        guard let count = optInt(args, "count", 1...500, 1) else { return fail(0, "invalid_args", "count must be a whole number 1–500", sent: false) }
        guard a.keyboards.firstMatch.exists else {
            return fail(0, "no_keyboard", "no keyboard", sent: false)
        }
        let t0 = Date()
        let raw = key == "delete" ? XCUIKeyboardKey.delete.rawValue : XCUIKeyboardKey.return.rawValue
        a.typeText(String(repeating: raw, count: count))
        return ok(0, ["ms": msSince(t0)])
    }

    // MARK: screenshot

    @MainActor
    static func screenshotCmd() -> [String: Any] {
        let t0 = Date()
        guard let png = XCUIScreen.main.screenshot().pngRepresentation as Data? else {
            return fail(0, "screenshot_failed", "no png")
        }
        let scr = screen()
        return ok(0, ["png_base64": png.base64EncodedString(), "w": Int(scr.width), "h": Int(scr.height), "ms": msSince(t0)])
    }

    // MARK: front — what SpringBoard itself is showing
    //
    // Public XCUITest cannot name the app in front. It can tell whether SpringBoard's own Home Screen is on
    // screen (its icons are) and where SpringBoard's alerts are.

    struct SBAlert {
        let frame: CGRect
        let buttons: [CGRect]
    }

    @MainActor
    static func springboardFront() -> (icons: Int, alerts: [SBAlert])? {
        let snap: XCUIElementSnapshot
        do { snap = try app("com.apple.springboard").snapshot() } catch { return nil }
        let scr = screen()
        var icons = 0
        var alerts: [SBAlert] = []
        func shown(_ s: XCUIElementSnapshot) -> Bool { s.frame.width > 0 && s.frame.height > 0 && s.frame.intersects(scr) }
        func buttons(_ s: XCUIElementSnapshot, _ out: inout [CGRect]) {
            if s.elementType == .button && shown(s) { out.append(s.frame) }
            for c in s.children { buttons(c, &out) }
        }
        func walk(_ s: XCUIElementSnapshot) {
            if shown(s) && s.elementType == .icon { icons += 1 }
            // an alert only: a sheet's frame can cover the whole screen (pre-review P3)
            if shown(s) && s.elementType == .alert {
                var b: [CGRect] = []
                buttons(s, &b)
                alerts.append(SBAlert(frame: s.frame, buttons: b))
            }
            for c in s.children { walk(c) }
        }
        walk(snap)
        return (icons, alerts)
    }

    enum SBInput { case tap, press, drag, text }

    // review S4A-s8-g-1: a system alert (a permission prompt, say) sits over the app in front while the app still reads
    // "in front", and the app's own snapshot does not show it. Input named for an app is not sent while one is up: a tap
    // at the app's point would press the alert's button, and text would go to the alert's field. SpringBoard that
    // cannot be read fails closed. Returns the refusal, or nil.
    @MainActor
    static func alertRefusal() -> [String: Any]? {
        guard let f = springboardFront() else { return fail(0, "system_alert", "com.apple.springboard could not be read, so a system alert could not be ruled out", sent: false) }
        if !f.alerts.isEmpty { return fail(0, "system_alert", "a system alert is up over the app", sent: false) }
        return nil
    }

    // com.apple.springboard always reads "running in the foreground", whatever is on screen, so its state says
    // nothing about where a point lands — and on the Home Screen itself a tap on an icon opens an app no rule
    // was asked about. With springboard_only: true a command named for it is sent in one case only: a single
    // tap whose point lies on a button of one of SpringBoard's alerts (a system prompt). A sheet does not count
    // (its frame can cover the screen), and nothing else is sent: no long press, no drag, no text and no key —
    // text goes wherever the keyboard focus is, which the public API does not show, and a second Return would
    // land on whatever the alert was covering (pre-review P3). Returns the refusal, or nil.
    @MainActor
    static func springboardRefusal(_ args: [String: Any], _ kind: SBInput, at point: CGPoint? = nil) -> [String: Any]? {
        guard let raw = args["springboard_only"] else { return nil }
        guard isBool(raw), let only = raw as? Bool else { return fail(0, "invalid_args", "springboard_only must be true or false", sent: false) }
        if !only { return nil }
        switch kind {
        case .drag: return fail(0, "app_not_foreground", "a drag named for com.apple.springboard is not sent", sent: false)
        case .press: return fail(0, "app_not_foreground", "a long press named for com.apple.springboard is not sent", sent: false)
        case .text: return fail(0, "app_not_foreground", "text and keys named for com.apple.springboard are not sent", sent: false)
        case .tap: break
        }
        if let c = args["count"] {
            guard !isBool(c), let n = c as? Int, (1...3).contains(n) else { return fail(0, "invalid_args", "count must be a whole number 1–3", sent: false) }
            if n != 1 { return fail(0, "app_not_foreground", "more than one tap named for com.apple.springboard is not sent", sent: false) }
        }
        guard let p = point, let f = springboardFront() else { return fail(0, "app_not_foreground", "com.apple.springboard could not be read", sent: false) }
        if f.alerts.contains(where: { a in a.frame.contains(p) && a.buttons.contains(where: { $0.contains(p) }) }) { return nil }
        return fail(0, "app_not_foreground", "the point is not on a button of one of SpringBoard's alerts", sent: false)
    }

    @MainActor
    static func frontCmd() -> [String: Any] {
        let t0 = Date()
        guard let f = springboardFront() else { return fail(0, "snapshot_failed", "com.apple.springboard could not be read") }
        return ok(0, [
            "home": f.icons > 0,
            "icons": f.icons,
            "alerts": f.alerts.map { a in [a.frame.minX, a.frame.minY, a.frame.width, a.frame.height].map { Double(round($0 * 10) / 10) } },
            "alert_buttons": f.alerts.reduce(0) { $0 + $1.buttons.count },
            "ms": msSince(t0),
        ])
    }

    // MARK: snapshot

    static let interactiveTypes: Set<XCUIElement.ElementType> = [
        .button, .cell, .textField, .secureTextField, .searchField, .textView, .switch,
        .slider, .link, .tab, .key, .menuItem, .segmentedControl, .pickerWheel, .stepper, .toggle,
    ]

    static func typeName(_ t: XCUIElement.ElementType) -> String {
        switch t {
        case .any: return "any"
        case .application: return "application"
        case .activityIndicator: return "activityIndicator"
        case .alert: return "alert"
        case .browser: return "browser"
        case .button: return "button"
        case .cell: return "cell"
        case .checkBox: return "checkBox"
        case .collectionView: return "collectionView"
        case .comboBox: return "comboBox"
        case .datePicker: return "datePicker"
        case .decrementArrow: return "decrementArrow"
        case .dialog: return "dialog"
        case .image: return "image"
        case .incrementArrow: return "incrementArrow"
        case .key: return "key"
        case .keyboard: return "keyboard"
        case .link: return "link"
        case .map: return "map"
        case .menu: return "menu"
        case .menuBar: return "menuBar"
        case .menuItem: return "menuItem"
        case .navigationBar: return "navigationBar"
        case .other: return "other"
        case .pageIndicator: return "pageIndicator"
        case .picker: return "picker"
        case .pickerWheel: return "pickerWheel"
        case .popUpButton: return "popUpButton"
        case .progressIndicator: return "progressIndicator"
        case .radioButton: return "radioButton"
        case .radioGroup: return "radioGroup"
        case .scrollBar: return "scrollBar"
        case .scrollView: return "scrollView"
        case .icon: return "icon"
        case .searchField: return "searchField"
        case .segmentedControl: return "segmentedControl"
        case .sheet: return "sheet"
        case .slider: return "slider"
        case .splitGroup: return "splitGroup"
        case .staticText: return "staticText"
        case .statusBar: return "statusBar"
        case .stepper: return "stepper"
        case .switch: return "switch"
        case .tab: return "tab"
        case .tabBar: return "tabBar"
        case .table: return "table"
        case .textField: return "textField"
        case .secureTextField: return "secureTextField"   // review S4A-s8-reviewer-1: it fell to "other"
        case .textView: return "textView"
        case .toggle: return "toggle"
        case .toolbar: return "toolbar"
        case .webView: return "webView"
        case .window: return "window"
        case .touchBar: return "touchBar"
        case .statusItem: return "statusItem"
        case .layoutArea: return "layoutArea"
        case .layoutItem: return "layoutItem"
        case .handle: return "handle"
        case .grid: return "grid"
        case .tableRow: return "tableRow"
        case .tableColumn: return "tableColumn"
        case .outline: return "outline"
        case .colorWell: return "colorWell"
        case .dockItem: return "dockItem"
        case .tabGroup: return "tabGroup"
        case .levelIndicator: return "levelIndicator"
        case .valueIndicator: return "valueIndicator"
        @unknown default: return "other"
        }
    }

    struct FlatNode {
        let type: XCUIElement.ElementType
        let label: String
        let ident: String
        let value: String
        let placeholder: String
        let frame: CGRect
        let enabled: Bool
        let selected: Bool
    }

    static func flatten(_ s: XCUIElementSnapshot) -> [FlatNode] {
        var out: [FlatNode] = []
        // a row's label: its own, or the labels inside it in reading order, joined (cut at 200 characters by the caller)
        func rowText(_ s: XCUIElementSnapshot) -> String {
            if !s.label.isEmpty { return s.label }
            var parts: [String] = []
            var length = 0
            func collect(_ n: XCUIElementSnapshot) {
                for c in n.children {
                    if length > 200 { return }
                    if c.label.isEmpty { collect(c) } else if parts.last != c.label { parts.append(c.label); length += c.label.count + 2 }
                }
            }
            collect(s)
            return parts.joined(separator: ", ")
        }
        func walk(_ s: XCUIElementSnapshot) {
            let isRow = s.elementType == .cell
            out.append(FlatNode(
                type: s.elementType,
                label: isRow ? rowText(s) : s.label,
                ident: s.identifier,
                value: (s.value as? String) ?? "",
                placeholder: s.placeholderValue ?? "",
                frame: s.frame,
                enabled: s.isEnabled,
                selected: s.isSelected))
            for c in s.children { walk(c) }
        }
        walk(s)
        return out
    }

    @MainActor
    static func snapshot(_ args: [String: Any]) -> [String: Any] {
        guard let bundle = args["bundle_id"] as? String, validBundleId(bundle) else {
            return fail(0, "invalid_args", "bad bundle_id")
        }
        guard let maxNodes = optInt(args, "max_nodes", 1...1000, 400) else { return fail(0, "invalid_args", "max_nodes must be a whole number 1–1000") }
        let a = app(bundle)
        let st = a.state
        if st == .notRunning || st == .unknown {
            return fail(0, "app_not_running", "state \(st.rawValue)")
        }
        let t0 = Date()
        let snap: XCUIElementSnapshot
        do { snap = try a.snapshot() } catch {
            return fail(0, "snapshot_failed", error.localizedDescription)
        }
        let scr = screen()
        var nodes: [[String: Any]] = []
        var truncated = false
        for n in flatten(snap) {
            guard n.frame.width > 0, n.frame.height > 0 else { continue }
            guard n.frame.intersects(scr) else { continue }
            guard !n.label.isEmpty || interactiveTypes.contains(n.type) else { continue }
            if nodes.count >= maxNodes { truncated = true; break }
            var obj: [String: Any] = [
                "i": nodes.count,
                "type": typeName(n.type),
                "label": String(n.label.prefix(200)),
                "id": String(n.ident.prefix(80)),
                "frame": [n.frame.minX, n.frame.minY, n.frame.width, n.frame.height].map { Double(round($0 * 10) / 10) },
                "enabled": n.enabled,
                "selected": n.selected,
            ]
            if n.type == .textField || n.type == .searchField || n.type == .textView || n.type == .switch || n.type == .slider {
                // an empty text field reports its placeholder as its value: that is not content
                var v = n.value
                if !n.placeholder.isEmpty {
                    obj["placeholder"] = String(n.placeholder.prefix(200))
                    if v == n.placeholder { v = "" }
                }
                obj["value"] = String(v.prefix(4000))
                if v.count > 4000 { obj["value_truncated"] = true }
            }
            nodes.append(obj)
        }
        return ok(0, [
            "bundle_id": bundle,
            "state": st.rawValue,
            "screen": ["w": scr.width, "h": scr.height],
            "nodes": nodes,
            "truncated": truncated,
            "ms": msSince(t0),
        ])
    }
}
