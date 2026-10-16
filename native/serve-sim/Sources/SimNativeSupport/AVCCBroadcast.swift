// Modified for bb-plugin-ios-simulator: share encoding without sharing client backpressure.
import Foundation

public struct AVCCDeliveryFrame: Sendable {
    public let data: Data
    public let description: Data?
    public let isKeyframe: Bool
    public let width: Int
    public let height: Int

    public init(data: Data, description: Data? = nil, isKeyframe: Bool, width: Int, height: Int) {
        self.data = data; self.description = description; self.isKeyframe = isKeyframe
        self.width = width; self.height = height
    }
}

/// A request made while VideoToolbox is encoding must survive that encode's completion.
public struct AVCCKeyframeRequests {
    public private(set) var generation: UInt64 = 1
    private var completed: UInt64 = 0
    public var needed: Bool { generation != completed }
    public init() {}
    public mutating func request() { generation &+= 1 }
    public mutating func encodedKeyframe(for generation: UInt64) { completed = generation }
}

/// One compressed stream, with independent bounded delivery for each decoder.
public actor AVCCBroadcast {
    private final class Subscriber {
        let send: (AVCCDeliveryFrame) async -> Void
        var frames: [AVCCDeliveryFrame] = []
        var bytes = 0
        var inFlightBytes = 0
        var waitingForKeyframe = true
        var task: Task<Void, Never>?
        init(send: @escaping (AVCCDeliveryFrame) async -> Void) { self.send = send }
        func reset() { frames.removeAll(keepingCapacity: true); bytes = 0; waitingForKeyframe = true }
    }

    private var subscribers: [UUID: Subscriber] = [:]
    private var description: Data?
    private var stopped = false
    private var requestTask: Task<Void, Never>?
    private var lastRequest: ContinuousClock.Instant?
    private let maxFrames: Int
    private let maxBytes: Int
    private let maxPacketBytes: Int
    private let keyframeInterval: Duration
    private var requestKeyframe: (@Sendable () async -> Void)?

    public init(maxFrames: Int = 8, maxBytes: Int = 2 * 1024 * 1024, maxPacketBytes: Int = 64 * 1024 * 1024,
                keyframeInterval: Duration = .milliseconds(250), requestKeyframe: @escaping @Sendable () async -> Void) {
        self.maxFrames = max(1, maxFrames); self.maxBytes = max(1, maxBytes)
        self.maxPacketBytes = max(self.maxBytes, maxPacketBytes)
        self.keyframeInterval = keyframeInterval; self.requestKeyframe = requestKeyframe
    }

    public func subscribe(_ id: UUID, send: @escaping (AVCCDeliveryFrame) async -> Void) {
        guard !stopped else { return }
        subscribers[id] = Subscriber(send: send)
        scheduleKeyframe()
    }

    public func unsubscribe(_ id: UUID) {
        if let subscriber = subscribers.removeValue(forKey: id) { subscriber.reset(); subscriber.task?.cancel() }
        if subscribers.isEmpty { requestTask?.cancel(); requestTask = nil }
    }

    public func publish(_ frame: AVCCDeliveryFrame) {
        guard !stopped else { return }
        if let next = frame.description, next != description {
            description = next
            for subscriber in subscribers.values { subscriber.reset() }
        }
        var needsKeyframe = false
        for (id, subscriber) in subscribers {
            let size = frame.data.count + (description?.count ?? 0)
            // Reject corrupt/unbounded packets without an endless force-IDR loop.
            guard size <= maxPacketBytes, description != nil else { subscriber.reset(); continue }
            // Keep a valid oversized IDR until its drain starts. It is the only
            // retained packet, including in-flight data, up to the wire ceiling.
            if subscriber.bytes > maxBytes || subscriber.inFlightBytes > maxBytes {
                subscriber.waitingForKeyframe = true; continue
            }
            let count = subscriber.frames.count + (subscriber.inFlightBytes > 0 ? 1 : 0)
            if count >= maxFrames || subscriber.bytes + subscriber.inFlightBytes + size > maxBytes { subscriber.reset() }
            if subscriber.waitingForKeyframe && (!frame.isKeyframe || (size > maxBytes && subscriber.inFlightBytes > 0)) {
                needsKeyframe = needsKeyframe || subscriber.inFlightBytes == 0; continue
            }
            if subscriber.inFlightBytes + size > maxBytes && size <= maxBytes { continue }
            let packet = AVCCDeliveryFrame(data: frame.data,
                description: subscriber.waitingForKeyframe ? description : nil,
                isKeyframe: frame.isKeyframe, width: frame.width, height: frame.height)
            subscriber.waitingForKeyframe = false
            subscriber.frames.append(packet)
            subscriber.bytes += packet.data.count + (packet.description?.count ?? 0)
            if subscriber.task == nil { subscriber.task = Task { await self.drain(id, subscriber) } }
        }
        if needsKeyframe { scheduleKeyframe() }
    }

    private func drain(_ id: UUID, _ subscriber: Subscriber) async {
        while !Task.isCancelled, subscribers[id] === subscriber, !subscriber.frames.isEmpty {
            let frame = subscriber.frames.removeFirst()
            subscriber.bytes -= frame.data.count + (frame.description?.count ?? 0)
            subscriber.inFlightBytes = frame.data.count + (frame.description?.count ?? 0)
            await subscriber.send(frame)
            subscriber.inFlightBytes = 0
        }
        subscriber.task = nil
        if !stopped, subscribers[id] === subscriber, subscriber.waitingForKeyframe { scheduleKeyframe() }
    }

    private func scheduleKeyframe() {
        guard requestTask == nil, !stopped, !subscribers.isEmpty else { return }
        let now = ContinuousClock.now
        let delay = lastRequest.map { max(.zero, now.duration(to: $0.advanced(by: keyframeInterval))) } ?? .zero
        requestTask = Task { [weak self] in
            do { try await Task.sleep(for: delay) } catch { return }
            guard !Task.isCancelled else { return }
            await self?.sendKeyframeRequest()
        }
    }

    private func sendKeyframeRequest() async {
        requestTask = nil
        guard !stopped, !subscribers.isEmpty else { return }
        lastRequest = .now
        await requestKeyframe?()
    }

    public func stop() {
        stopped = true; requestTask?.cancel(); requestTask = nil
        for subscriber in subscribers.values { subscriber.task?.cancel(); subscriber.reset() }
        subscribers.removeAll(); description = nil; requestKeyframe = nil
    }
}
