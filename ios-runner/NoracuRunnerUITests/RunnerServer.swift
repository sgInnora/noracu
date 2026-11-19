// SPDX-License-Identifier: MIT
// RunnerServer.swift — TCP line server for protocol v1: framing, token check, peer filter,
// and dispatch of one command at a time onto the main thread. MIT licensed, see LICENSE.

import Foundation
import Network

final class RunnerServer: @unchecked Sendable {
    let box: RunnerBox
    private let queue = DispatchQueue(label: "noracu.runner.conn")

    init(box: RunnerBox) { self.box = box }

    func accept(_ conn: NWConnection) {
        var reading = false   // touched on `queue` only
        conn.stateUpdateHandler = { [weak self] st in
            guard let self else { return }
            if case .ready = st {
                // fail-closed peer check, before the first byte is read: an endpoint that is missing,
                // not a hostPort, or outside the allowed range closes the connection at once
                if !self.peerAllowed(conn.endpoint) {
                    conn.cancel()
                    return
                }
                if !reading { reading = true; self.serve(conn, Data()) }
            }
            if case .failed = st { conn.cancel() }
        }
        conn.start(queue: queue)
    }

    private func peerAllowed(_ ep: NWEndpoint) -> Bool {
        guard case let .hostPort(host, _) = ep else { return false }
        if case let .ipv4(v4) = host {
            return box.isLoopbackBind && v4.rawValue[0] == 127
        }
        if case let .ipv6(v6) = host {
            if box.isLoopbackBind { return v6.isLoopback }
            if let bind6 = box.bindIPv6 {
                return samePrefix64(v6, bind6)
            }
            return false
        }
        return false
    }

    private func samePrefix64(_ a: IPv6Address, _ b: IPv6Address) -> Bool {
        let x = a.rawValue, y = b.rawValue
        guard x.count == 16, y.count == 16 else { return false }
        for i in 0..<8 where x[i] != y[i] { return false }
        return true
    }

    private func serve(_ conn: NWConnection, _ buf: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var b = buf
            if let d = data { b.append(d) }
            // a single line over 64 KiB closes the connection: only when the
            // first 64 KiB of the buffer hold no newline. Multiple complete
            // short lines accumulating past 64 KiB are fine.
            if let nl = b.firstIndex(of: 0x0A) {
                if b.distance(from: b.startIndex, to: nl) > 65536 {
                    conn.cancel()
                    return
                }
            } else if b.count > 65536 {
                conn.cancel()
                return
            }
            while let nl = b.firstIndex(of: 0x0A) {
                let raw = b[b.startIndex..<nl]
                b = Data(b[b.index(after: nl)...])
                guard let line = String(data: Data(raw), encoding: .utf8) else {
                    conn.cancel()
                    return
                }
                // an auth failure or a quit ends this connection: what follows it in the buffer is not read
                if !self.handleLine(line, conn) { return }
                if self.box.done { conn.cancel(); return }
                if conn.state == .cancelled { return }
            }
            if isComplete || error != nil { conn.cancel(); return }
            self.serve(conn, b)
        }
    }

    private func handleLine(_ line: String, _ conn: NWConnection) -> Bool {
        // Before the token check passes, reply only "auth" — malformed JSON or
        // a missing token field is treated as an auth failure.
        guard let data = line.data(using: .utf8),
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let token = obj["token"] as? String else {
            sendThenClose(conn, ["id": 0, "ok": false, "error": "auth"])
            return false
        }
        let id = obj["id"].flatMap { RunnerCommands.isBool($0) ? nil : ($0 as? Int) } ?? 0
        if !constantTimeEqual(token, box.token) {
            sendThenClose(conn, ["id": id, "ok": false, "error": "auth"])
            return false
        }
        guard let rawId = obj["id"], !RunnerCommands.isBool(rawId), rawId is Int else {
            // a missing id, or one that is not a whole number, cannot be matched to its request: the command is not run
            var no = RunnerCommands.fail(0, "invalid_args", "id must be a whole number", sent: RunnerCommands.inputOps.contains(obj["op"] as? String ?? "") ? false : nil)
            no["id"] = 0
            send(conn, no)
            return true
        }
        DispatchQueue.main.async { self.box.served += 1 }
        let op = obj["op"] as? String ?? ""
        if op == "quit" {
            sendQuitReply(conn, id: id)
            return false
        }
        let input = RunnerCommands.inputOps.contains(op)
        if let rawArgs = obj["args"], !(rawArgs is [String: Any]) {
            var no = RunnerCommands.fail(0, "invalid_args", "args must be an object", sent: input ? false : nil)
            no["id"] = id
            send(conn, no)
            return true
        }
        let args = obj["args"] as? [String: Any] ?? [:]
        let reply = DispatchQueue.main.sync { () -> [String: Any] in
            MainActor.assumeIsolated {
                // A failure XCTest recorded between two commands belongs to one that has already answered:
                // this command is not run, and says why. (ping stays a plain sign of life.)
                if op != "ping", self.box.issueCount > self.box.issuesAnswered {
                    self.box.issuesAnswered = self.box.issueCount
                    return RunnerCommands.fail(0, "xctest_issue", "recorded after an earlier command had answered: " + self.box.lastIssue, sent: input ? false : nil)
                }
                let r = RunnerCommands.dispatch(op: op, args: args, box: self.box)
                guard op != "ping", self.box.issueCount > self.box.issuesAnswered else { return r }
                self.box.issuesAnswered = self.box.issueCount
                // XCTest recorded a failure during the call and carried on (continueAfterFailure): whatever the
                // command answered, it did not do what that says. Only a refusal that sent nothing stays "not sent".
                let nothingSent = (r["ok"] as? Bool) == false && (r["sent"] as? Bool) == false
                return RunnerCommands.fail(0, "xctest_issue", self.box.lastIssue, sent: input ? (nothingSent ? false : "unknown") : nil)
            }
        }
        var stamped = reply
        stamped["id"] = id
        send(conn, stamped)
        return true
    }

    private func send(_ conn: NWConnection, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else { return }
        var payload = data
        payload.append(0x0A)
        conn.send(content: payload, completion: .contentProcessed { _ in })
    }

    // auth failure: the reply must actually go out before the connection closes
    private func sendThenClose(_ conn: NWConnection, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys]) else {
            conn.cancel()
            return
        }
        var payload = data
        payload.append(0x0A)
        conn.send(content: payload, completion: .contentProcessed { _ in conn.cancel() })
    }

    // quit: send the reply, then close the connection and end the test only
    // after the reply has actually gone out.
    private func sendQuitReply(_ conn: NWConnection, id: Int) {
        guard let data = try? JSONSerialization.data(withJSONObject: ["id": id, "ok": true, "result": [:]], options: [.sortedKeys]) else {
            conn.cancel()
            return
        }
        var payload = data
        payload.append(0x0A)
        conn.send(content: payload, completion: .contentProcessed { [weak self] _ in
            conn.cancel()
            DispatchQueue.main.async { self?.box.done = true }
        })
    }

    private func constantTimeEqual(_ a: String, _ b: String) -> Bool {
        let ab = Array(a.utf8), bb = Array(b.utf8)
        if ab.count != bb.count { return false }
        var diff: UInt8 = 0
        for i in 0..<ab.count { diff |= ab[i] ^ bb[i] }
        return diff == 0
    }
}
