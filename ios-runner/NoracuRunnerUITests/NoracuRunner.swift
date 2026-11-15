// SPDX-License-Identifier: MIT
// NoracuRunner.swift — the noracu iOS runner: one long UI test that starts a TCP line server
// and executes protocol v1 commands (see README.md). MIT licensed, see LICENSE.

import XCTest
import Network

// What this runner was built from: a hash of its own sources, kept up to date by scripts/gen-runner-build.mjs
// (a test fails when it is not). It goes out on the ready line; the Mac side does not use a runner whose build
// is not the one its own copy of these sources names.
let noracuRunnerBuild = "c6905871df8d"

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
    private var _ready = false
    private var _listenerError: String?
    var ready: Bool { stateLock.lock(); defer { stateLock.unlock() }; return _ready }
    var listenerError: String? { stateLock.lock(); defer { stateLock.unlock() }; return _listenerError }

    func setReady() { stateLock.lock(); _ready = true; stateLock.unlock() }
    func setListenerError(_ e: String) {
        stateLock.lock(); if _listenerError == nil { _listenerError = e }; stateLock.unlock()
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

    // 32 characters, each 0-9 or a-f, ASCII only
    static func validToken(_ t: String) -> Bool {
        let u = Array(t.utf8)
        return u.count == 32 && u.allSatisfy { ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102) }
    }

    init?(env: [String: String]) {
        let token = env["NORACU_TOKEN"] ?? ""
        guard RunnerBox.validToken(token) else { return nil }
        self.token = token
        self.selftest = env["NORACU_SELFTEST"] == "1"
        let bind = env["NORACU_BIND"] ?? ""
        // check IPv4 first: IPv6Address("127.0.0.1") may parse as a mapped address
        // review S4A-s8-g-2: only a loopback address, or the unique-local (fc00::/7) address of the CoreDevice tunnel —
        // never a wildcard (0.0.0.0, ::), a link-local address or a Wi-Fi / cellular address: those listen beyond the tunnel
        if let v4 = IPv4Address(bind) {
            guard v4.rawValue[0] == 127 else { return nil }
            self.bindHost = .ipv4(v4)
            self.bindIPv6 = nil
            self.isLoopbackBind = v4.rawValue[0] == 127
        } else if let v6 = IPv6Address(bind) {
            let r = v6.rawValue
            guard v6.isLoopback || (r.count == 16 && (r[0] & 0xfe) == 0xfc) else { return nil }
            self.bindHost = .ipv6(v6)
            self.bindIPv6 = v6
            self.isLoopbackBind = v6.isLoopback
        } else {
            return nil
        }
        guard let p = Int(env["NORACU_PORT"] ?? ""), (49152...65535).contains(p) else { return nil }
        self.port = NWEndpoint.Port(rawValue: UInt16(p))!
    }
}

extension IPv6Address {
    var isLoopback: Bool {
        // ::1
        let raw = self.rawValue
        return raw.count == 16 && raw[15] == 1 && raw[0..<15].allSatisfy({ $0 == 0 })
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
            // distinguish which part was bad
            let token = env["NORACU_TOKEN"] ?? ""
            if !RunnerBox.validToken(token) {
                bail("bad_token", "token len=\(token.count)")
            } else if IPv4Address(env["NORACU_BIND"] ?? "") == nil && IPv6Address(env["NORACU_BIND"] ?? "") == nil {
                bail("bad_bind", "bind=\(env["NORACU_BIND"] ?? "<nil>")")
            } else {
                bail("bad_port", "port=\(env["NORACU_PORT"] ?? "<nil>")")
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
            case .ready: box.setReady()
            case .failed(let e): box.setListenerError("failed: \(e)")
            case .waiting(let e): box.setListenerError("waiting: \(e)")
            default: break
            }
        }
        listener.newConnectionHandler = { conn in server.accept(conn) }
        listener.start(queue: q)

        let readyDeadline = Date().addingTimeInterval(10)
        while !box.ready && box.listenerError == nil && Date() < readyDeadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.05))
        }
        if !box.ready {
            let detail = box.listenerError ?? "listener not ready after 10s"
            listener.cancel()
            bail("bind_failed", detail)
            return
        }
        print("NORACU_RUNNER ready v=1 port=\(box.port.rawValue) build=\(noracuRunnerBuild)")
        fflush(stdout)

        let deadline = Date().addingTimeInterval(12 * 3600)
        while !box.done && Date() < deadline {
            RunLoop.current.run(until: Date().addingTimeInterval(0.2))
        }
        listener.cancel()
        print("NORACU_RUNNER exit served=\(box.served) by_quit=\(box.done)")
        fflush(stdout)
    }
}
