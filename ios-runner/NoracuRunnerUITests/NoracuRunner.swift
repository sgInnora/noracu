// SPDX-License-Identifier: MIT
// NoracuRunner.swift — the noracu iOS runner: one long UI test that starts a TCP line server
// and executes protocol v1 commands (see README.md). MIT licensed, see LICENSE.

import XCTest
import Network

// What this runner was built from: a hash of its own sources, kept up to date by scripts/gen-runner-build.mjs
// (a test fails when it is not). It goes out on the ready line; the Mac side does not use a runner whose build
// is not the one its own copy of these sources names.
let noracuRunnerBuild = "b4383f0898e5"

// MARK: - pure rules (no XCTest: test/ios-runner-rules.mjs compiles this block on its own and runs it)

enum NoracuRules {
    // 32 characters, each 0-9 or a-f, ASCII only
    static func validToken(_ t: String) -> Bool {
        let u = Array(t.utf8)
        return u.count == 32 && u.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    // NORACU_BIND: a loopback address, or the unique-local (fc00::/7) address of the CoreDevice tunnel — never a
    // wildcard (0.0.0.0, ::), a link-local address or a Wi-Fi / cellular address: those listen beyond the tunnel.
    // IPv4 is checked first: IPv6Address("127.0.0.1") may parse as a mapped address.
    static func bind(_ s: String) -> (host: NWEndpoint.Host, v6: IPv6Address?, loopback: Bool)? {
        if let v4 = IPv4Address(s) {
            guard v4.rawValue[0] == 127 else { return nil }
            return (.ipv4(v4), nil, true)
        }
        if let v6 = IPv6Address(s) {
            let r = v6.rawValue
            guard v6.isLoopback || (r.count == 16 && (r[0] & 0xfe) == 0xfc) else { return nil }
            return (.ipv6(v6), v6, v6.isLoopback)
        }
        return nil
    }

    // NORACU_PORT: 49152-65535
    static func port(_ s: String) -> NWEndpoint.Port? {
        guard let p = Int(s), (49152...65535).contains(p) else { return nil }
        return NWEndpoint.Port(rawValue: UInt16(p))
    }

    // the setting that is wrong, in the order they are checked; nil when all three are good. An address that
    // parses but is not one the runner listens on is bad_bind (it was reported as bad_port).
    static func problem(_ env: [String: String]) -> String? {
        if !validToken(env["NORACU_TOKEN"] ?? "") { return "bad_token" }
        if bind(env["NORACU_BIND"] ?? "") == nil { return "bad_bind" }
        if port(env["NORACU_PORT"] ?? "") == nil { return "bad_port" }
        return nil
    }
}

// The listener's states as the ready wait and the serve loop read them. Waiting is not a failure: NWListener says
// .waiting while the network path is not there yet (the CoreDevice tunnel coming up) and may still become ready
// within the wait. Failed or cancelled is: the listener is gone. Every state that was not ready is kept (the
// first eight) for the bind_failed detail, the failure ahead of a waiting. After ready, a listener that is gone
// ends the session: nothing listens any more, and the runner would otherwise stay up until its 12 hours ran out.
struct NoracuListenerWatch {
    private(set) var ready = false
    private(set) var failure: String?
    private(set) var waiting: String?
    private(set) var notes: [String] = []

    mutating func note(_ kind: String, _ detail: String = "") {
        switch kind {
        case "ready": ready = true; waiting = nil
        case "waiting": waiting = detail; remember("waiting: \(detail)")
        case "failed": failure = "failed: \(detail)"; remember(failure!)
        case "cancelled": failure = "cancelled"; remember("cancelled")
        default: break
        }
    }
    private mutating func remember(_ s: String) { if notes.count < 8 { notes.append(s) } }

    // the ready wait ends: ready, or the listener gone (a waiting listener is waited for until the deadline)
    var settled: Bool { ready || failure != nil }
    // why it is not ready, for bind_failed: the failure, else the latest waiting, else nil (the deadline passed)
    var notReadyDetail: String? { failure ?? waiting.map { "waiting: \($0)" } }
    // after ready: the listener is gone
    var gone: Bool { ready && failure != nil }
}

extension IPv6Address {
    var isLoopback: Bool {
        // ::1
        let raw = self.rawValue
        return raw.count == 16 && raw[15] == 1 && raw[0..<15].allSatisfy({ $0 == 0 })
    }
}

// MARK: - end of pure rules

// MARK: - shared state

final class RunnerBox: @unchecked Sendable {
    var done = false
    var served = 0
    let started = Date()
    let token: String
    let bindHost: NWEndpoint.Host
    let port: NWEndpoint.Port
    let isLoopbackBind: Bool
    let bindIPv6: IPv6Address?
    // listener state, written on the listener queue, read on main
    private let stateLock = NSLock()
    private var _watch = NoracuListenerWatch()
    var listener: NoracuListenerWatch { stateLock.lock(); defer { stateLock.unlock() }; return _watch }
    func noteListener(_ kind: String, _ detail: String = "") {
        stateLock.lock(); _watch.note(kind, detail); stateLock.unlock()
    }

    // failures XCTest recorded while the test ran (see NoracuRunner.record)
    private var _issues = 0
    private var _lastIssue = ""
    var issueCount: Int { stateLock.lock(); defer { stateLock.unlock() }; return _issues }
    var lastIssue: String { stateLock.lock(); defer { stateLock.unlock() }; return _lastIssue }
    func noteIssue(_ d: String) {
        stateLock.lock(); _issues += 1; _lastIssue = String(d.prefix(300)); stateLock.unlock()
    }
    var issuesAnswered = 0   // main thread only: how many of them a command has already reported
    // NORACU_SELFTEST=1 (set by the live test only) makes the runner answer the selftest_issue op
    let selftest: Bool

    init?(env: [String: String]) {
        guard NoracuRules.problem(env) == nil,
              let b = NoracuRules.bind(env["NORACU_BIND"] ?? ""),
              let p = NoracuRules.port(env["NORACU_PORT"] ?? "") else { return nil }
        self.token = env["NORACU_TOKEN"] ?? ""
        self.selftest = env["NORACU_SELFTEST"] == "1"
        self.bindHost = b.host
        self.bindIPv6 = b.v6
        self.isLoopbackBind = b.loopback
        self.port = p
    }
}

// MARK: - the test

final class NoracuRunner: XCTestCase {
    override func setUpWithError() throws { continueAfterFailure = true }

    private var liveBox: RunnerBox?

    // continueAfterFailure is on so that one failed gesture does not end the session. Every failure XCTest
    // records is counted, and the command during which it happened answers xctest_issue instead of ok.
    override func record(_ issue: XCTIssue) {
        liveBox?.noteIssue(issue.compactDescription)
        super.record(issue)
    }

    // Make an early exit visible: XCTFail always shows in xcodebuild output,
    // and the run-loop wait gives stdout time to drain.
    private func bail(_ code: String, _ detail: String) {
        print("NORACU_RUNNER error \(code)")
        NSLog("NORACU_RUNNER error \(code): \(detail)")
        fflush(stdout)
        XCTFail("NORACU_RUNNER error \(code): \(detail)")
        RunLoop.current.run(until: Date().addingTimeInterval(2))
    }

    @MainActor
    func testServe() throws {
        let env = ProcessInfo.processInfo.environment
        guard let box = RunnerBox(env: env) else {
            // which setting was bad
            switch NoracuRules.problem(env) {
            case "bad_token": bail("bad_token", "token len=\((env["NORACU_TOKEN"] ?? "").count)")
            case "bad_bind": bail("bad_bind", "bind=\(env["NORACU_BIND"] ?? "<nil>") (a loopback or fc00::/7 address only)")
            default: bail("bad_port", "port=\(env["NORACU_PORT"] ?? "<nil>")")
            }
            return
        }
        liveBox = box

        let params = NWParameters.tcp
        params.requiredLocalEndpoint = NWEndpoint.hostPort(host: box.bindHost, port: box.port)
        let listener: NWListener
        do { listener = try NWListener(using: params) } catch {
            bail("bind_failed", "listener init: \(error)")
            return
        }
        let q = DispatchQueue(label: "noracu.runner")
        let server = RunnerServer(box: box)
        listener.stateUpdateHandler = { st in
            switch st {
            case .ready: box.noteListener("ready")
            case .failed(let e): box.noteListener("failed", "\(e)")
            case .waiting(let e): box.noteListener("waiting", "\(e)")
            case .cancelled: box.noteListener("cancelled")
            default: break
            }
        }
        listener.newConnectionHandler = { conn in server.accept(conn) }
        listener.start(queue: q)

        let readyDeadline = Date().addingTimeInterval(10)
        while !box.listener.settled && Date() < readyDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        let w = box.listener
        if !w.ready {
            let detail = (w.notReadyDetail ?? "listener not ready after 10s") + (w.notes.count > 1 ? " (states: \(w.notes.joined(separator: "; ")))" : "")
            listener.cancel()
            bail("bind_failed", detail)
            return
        }
        print("NORACU_RUNNER ready v=1 port=\(box.port.rawValue) build=\(noracuRunnerBuild)")
        fflush(stdout)

        let deadline = Date().addingTimeInterval(12 * 3600)
        while !box.done && !box.listener.gone && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        // the listener went away while the runner served: say so and end, instead of staying up with nothing listening
        if box.listener.gone {
            print("NORACU_RUNNER error listener_failed")
            NSLog("NORACU_RUNNER error listener_failed: \(box.listener.failure ?? "")")
            fflush(stdout)
        }
        listener.cancel()
        print("NORACU_RUNNER exit served=\(box.served) by_quit=\(box.done)")
        fflush(stdout)
    }
}
