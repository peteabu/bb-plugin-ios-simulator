import XCTest
@testable import SimNativeSupport

private actor ReceivedFrames {
    var frames: [AVCCDeliveryFrame] = []
    var requests = 0
    func append(_ frame: AVCCDeliveryFrame) { frames.append(frame) }
    func request() { requests += 1 }
}

private actor DeliveryGate {
    private var continuation: CheckedContinuation<Void, Never>?
    private var opened = false
    func wait() async {
        if !opened { await withCheckedContinuation { continuation = $0 } }
    }
    func open() { opened = true; continuation?.resume(); continuation = nil }
}

final class AVCCBroadcastTests: XCTestCase {
    private func frame(_ byte: UInt8, key: Bool = false, description: Data? = nil, size: Int = 2) -> AVCCDeliveryFrame {
        AVCCDeliveryFrame(data: Data(repeating: byte, count: size), description: description,
                          isKeyframe: key, width: 1206, height: 2622)
    }
    private func eventually(_ predicate: () async -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<200 {
            if await predicate() { return }
            try await Task.sleep(for: .milliseconds(5))
        }
        XCTFail("Timed out waiting for delivery", file: file, line: line)
    }

    func testOnePublicationReachesBothSubscribersAndLateJoinWaitsForConfigurationAndKeyframe() async throws {
        let a = ReceivedFrames(), b = ReceivedFrames(), requests = ReceivedFrames()
        let stream = AVCCBroadcast { await requests.request() }
        let first = UUID(), second = UUID()
        await stream.subscribe(first) { await a.append($0) }
        await stream.publish(frame(1, key: true, description: Data([7, 8])))
        try await eventually { await a.frames.count == 1 }
        await stream.subscribe(second) { await b.append($0) }
        await stream.publish(frame(2))
        try await eventually { await a.frames.count == 2 }
        let beforeKeyframe = await b.frames.count
        XCTAssertEqual(beforeKeyframe, 0)
        await stream.publish(frame(3, key: true))
        try await eventually { await b.frames.count == 1 }
        let joined = await b.frames[0]
        XCTAssertEqual(joined.description, Data([7, 8]))
        XCTAssertEqual(joined.data, Data([3, 3]))
        await stream.publish(frame(4))
        try await eventually { await b.frames.count == 2 }
        let aFrames = await a.frames, bFrames = await b.frames
        XCTAssertEqual(Array(aFrames.suffix(2)).map(\.data), bFrames.map(\.data))
        XCTAssertNil(bFrames[1].description)
        await stream.publish(frame(5, key: true, description: Data([9])))
        try await eventually { await b.frames.count == 3 }
        let changed = await b.frames.last!
        XCTAssertEqual(changed.description, Data([9]))
        await stream.stop()
    }

    func testSlowSubscriberDoesNotStallFastSubscriberAndOverflowResumesAtNewDecodeGroup() async throws {
        let slow = ReceivedFrames(), fast = ReceivedFrames(), requests = ReceivedFrames(), gate = DeliveryGate()
        let stream = AVCCBroadcast(maxFrames: 2, maxBytes: 10, keyframeInterval: .milliseconds(5)) { await requests.request() }
        await stream.subscribe(UUID()) { await slow.append($0); await gate.wait() }
        await stream.subscribe(UUID()) { await fast.append($0) }
        await stream.publish(frame(1, key: true, description: Data([7, 8])))
        try await eventually {
            let a = await slow.frames.count, b = await fast.frames.count
            return a == 1 && b == 1
        }
        try await eventually { await requests.requests >= 1 }
        let initialRequests = await requests.requests
        for byte in UInt8(2)...10 {
            await stream.publish(frame(byte))
            try await eventually { await fast.frames.count == Int(byte) }
        }
        try await Task.sleep(for: .milliseconds(20))
        let blockedFrames = await slow.frames.count, blockedRequests = await requests.requests
        XCTAssertEqual(blockedFrames, 1)
        XCTAssertEqual(blockedRequests, initialRequests, "Backpressured clients must not continuously force IDRs")
        await gate.open()
        try await eventually { await requests.requests > initialRequests }
        await stream.publish(frame(99, key: true))
        try await eventually { await slow.frames.count == 2 }
        let resumed = await slow.frames.last!
        XCTAssertEqual(resumed.data, Data([99, 99]))
        XCTAssertEqual(resumed.description, Data([7, 8]))
        await stream.stop()
    }

    func testOversizedIDRIsAllowedAloneAndInvalidPacketsDoNotCauseRequestSpin() async throws {
        let received = ReceivedFrames(), requests = ReceivedFrames(), gate = DeliveryGate()
        let stream = AVCCBroadcast(maxFrames: 2, maxBytes: 8, maxPacketBytes: 32, keyframeInterval: .milliseconds(5)) { await requests.request() }
        await stream.subscribe(UUID()) { await received.append($0); await gate.wait() }
        await stream.publish(frame(1, key: true, description: Data([7, 8]), size: 16))
        try await eventually { await received.frames.count == 1 }
        try await eventually { await requests.requests >= 1 }
        let firstRequests = await requests.requests
        for _ in 0..<10 { await stream.publish(frame(2)) }
        try await Task.sleep(for: .milliseconds(20))
        let duringRequests = await requests.requests
        XCTAssertEqual(duringRequests, firstRequests)
        await gate.open()
        try await eventually { await requests.requests > firstRequests }
        await stream.publish(frame(3, key: true, size: 16))
        try await eventually { await received.frames.count == 2 }
        let large = await received.frames.last!
        XCTAssertEqual(large.data.count + (large.description?.count ?? 0), 18)
        try await Task.sleep(for: .milliseconds(10))
        let beforeInvalid = await requests.requests
        for _ in 0..<10 { await stream.publish(frame(4, key: true, size: 64)) }
        try await Task.sleep(for: .milliseconds(20))
        let afterInvalid = await requests.requests, count = await received.frames.count
        XCTAssertEqual(afterInvalid, beforeInvalid)
        XCTAssertEqual(count, 2)
        await stream.stop()
    }

    func testUnsubscribeAndStopCancelQueuedDeliveryAndPendingRequests() async throws {
        let received = ReceivedFrames(), requests = ReceivedFrames(), gate = DeliveryGate()
        let stream = AVCCBroadcast(keyframeInterval: .milliseconds(40)) { await requests.request() }
        let id = UUID()
        await stream.subscribe(id) { await received.append($0); await gate.wait() }
        await stream.publish(frame(1, key: true, description: Data([7, 8])))
        try await eventually {
            let count = await received.frames.count, requested = await requests.requests
            return count == 1 && requested >= 1
        }
        await stream.publish(frame(2))
        await stream.unsubscribe(id)
        await stream.subscribe(UUID()) { await received.append($0) }
        let beforeStop = await requests.requests
        await stream.stop()
        await gate.open()
        await stream.publish(frame(3, key: true))
        try await Task.sleep(for: .milliseconds(60))
        let count = await received.frames.count, afterStop = await requests.requests
        XCTAssertEqual(count, 1)
        XCTAssertEqual(afterStop, beforeStop)
    }

    func testKeyframeRequestDuringEncodeCannotBeErasedByOlderCompletion() {
        var requests = AVCCKeyframeRequests()
        let first = requests.generation
        requests.request()
        requests.encodedKeyframe(for: first)
        XCTAssertTrue(requests.needed)
        requests.encodedKeyframe(for: requests.generation)
        XCTAssertFalse(requests.needed)
    }
}
