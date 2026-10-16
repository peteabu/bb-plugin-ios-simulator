import Foundation
import CoreVideo
import CoreMedia
import os
import SimNativeSupport

// Modified for bb-plugin-ios-simulator: one AVCC encoder per capture engine,
// with independently bounded, keyframe-safe subscriber delivery.

// The capture + encode engine, reused verbatim from SimStreamHelper. Replicates
// main.swift's frameHandler: MJPEG always encodes while clients exist; H.264 runs
// only while AVCC is active. Encoded bytes (JPEG, or natively-framed AVCC
// envelopes) are handed back through a Swift closure on a native encode thread;
// the node-swift binding (sim-module.swift) marshals them onto the JS thread via
// a NodeAsyncQueue (threadsafe function).

struct Frame: Identifiable {
    let id = UUID()
    let pixelBuffer: CVPixelBuffer
}

protocol FrameEncoder {
    associatedtype Encoded
    func encode(_ frame: Frame) async throws -> Encoded
}

protocol CaptureConsuming: Sendable {
    // this is intentionally synchronous. CaptureEngine sends all frames to all consumers,
    // and lets them handle internal backpressure as they see fit. if instead this were async
    // (and CaptureEngine waited for all consumers to finish), a single bad consumer could
    // jam up the entire pipeline.
    func handleFrame(_ frame: Frame)
}

actor CaptureConsumer<E: FrameEncoder>: CaptureConsuming {
    nonisolated let continuation: AsyncStream<Frame>.Continuation

    init(
        encoder: E,
        onFrame: @escaping @isolated(any) (E.Encoded) async -> Void
    ) {
        let (stream, continuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        self.continuation = continuation
        Task {
            _ = onFrame.isolation
            for await frame in stream {
                do {
                    let encoded = try await encoder.encode(frame)
                    await onFrame(encoded)
                } catch {
                    print("error encoding \(E.self) frame: \(error)")
                    continue
                }
            }
        }
    }

    nonisolated func handleFrame(_ frame: Frame) {
        continuation.yield(frame)
    }

    deinit { continuation.finish() }
}

actor CaptureEngine {
    private enum Phase {
        case unstarted
        case starting
        case running
        case stopped
    }

    private let deviceUDID: String
    private let frameCapture = FrameCapture()
    private var phase = Phase.unstarted

    // mjpeg is stateless so we can share a single encoder instance
    private let mjpegEncoder = MJPEGEncoder()
    private var avccBroadcast: AVCCBroadcast?
    private var avccSubscriptions = Set<UUID>()
    private var unsubscribeAVCC: (@Sendable () async -> Void)?

    private(set) var screenSize = Dimensions(width: 0, height: 0)
    private var consumers = [UUID: CaptureConsuming]()

    init(deviceUDID: String) {
        self.deviceUDID = deviceUDID
    }

    func setPreferredScreenSize(width: Int, height: Int) async {
        await frameCapture.setPreferredScreenSize(width: width, height: height)
    }

    func start() async throws {
        guard phase == .unstarted else { return }
        phase = .starting
        // Latch `started` only after capture actually begins: if start() throws
        // (e.g. device not booted), a later retry should still be allowed.
        let (frames, frameContinuation) = AsyncStream.makeStream(
            of: Frame.self,
            // drop old frames if there's backpressure
            bufferingPolicy: .bufferingNewest(1)
        )
        do {
            try await frameCapture.start(deviceUDID: deviceUDID) { pixelBuffer, _ in
                frameContinuation.yield(Frame(pixelBuffer: pixelBuffer))
            }
        } catch {
            // Preserve retryability after an ordinary start failure, but never
            // overwrite a concurrent stop() that moved the actor to .stopped.
            frameContinuation.finish()
            await frameCapture.stop()
            if phase == .starting { phase = .unstarted }
            throw error
        }
        // Actor methods are reentrant across the await above. A simulator can
        // be shut down while FrameCapture is starting; do not resurrect a
        // session that stop() already marked stopped.
        guard phase == .starting else {
            frameContinuation.finish()
            await frameCapture.stop()
            throw CancellationError()
        }
        Task {
            for await frame in frames {
                handleFrame(frame)
            }
        }
        phase = .running
    }

    private func addConsumer<E: FrameEncoder>(
        encoder: E,
        onFrame: sending @escaping @isolated(any) (E.Encoded) async -> Void
    ) -> (@Sendable () async -> Void) {
        let consumer = CaptureConsumer(encoder: encoder) { [weak self] encoded in
            guard let self, await self.phase == .running else { return }
            await onFrame(encoded)
        }
        let id = UUID()
        consumers[id] = consumer
        return { [weak self] in await self?.removeConsumer(id) }
    }

    private func removeConsumer(
        _ id: UUID
    ) {
        consumers.removeValue(forKey: id)
    }

    private func handleFrame(_ frame: Frame) {
        guard phase == .running else { return }
        screenSize = frame.pixelBuffer.dimensions
        for consumer in consumers.values {
            consumer.handleFrame(frame)
        }
    }

    func addMJPEGConsumer(
        onFrame: sending @escaping (Dimensions, Data) async -> Void
    ) -> (@Sendable () async -> Void) {
        return addConsumer(encoder: mjpegEncoder, onFrame: { [weak self] data in
            guard let self else { return }
            await onFrame(screenSize, data)
        })
    }

    func addAVCCConsumer(
        onFrame: sending @escaping (Dimensions, Data, Int32) async -> Void
    ) async -> (@Sendable () async -> Void) {
        guard phase != .stopped else { return {} }
        if avccBroadcast == nil {
            let encoder = AVCCEncoder()
            let broadcast = AVCCBroadcast { await encoder.requestKeyframe() }
            avccBroadcast = broadcast
            unsubscribeAVCC = addConsumer(encoder: encoder) { [weak self] encoded in
                guard let self, let encoded else { return }
                let key: Bool
                switch encoded.kind { case .keyframe: key = true; case .delta: key = false }
                await broadcast.publish(AVCCDeliveryFrame(
                    data: key ? AVCCEnvelope.keyframe(avcc: encoded.avcc) : AVCCEnvelope.delta(avcc: encoded.avcc),
                    description: encoded.description.map { AVCCEnvelope.description(avcc: $0) },
                    isKeyframe: key, width: screenSize.width, height: screenSize.height))
            }
        }
        let broadcast = avccBroadcast!, id = UUID()
        avccSubscriptions.insert(id)
        await broadcast.subscribe(id) { packet in
            let size = Dimensions(width: packet.width, height: packet.height)
            if let description = packet.description { await onFrame(size, description, 1 << 0) }
            guard !Task.isCancelled else { return }
            await onFrame(size, packet.data, packet.isKeyframe ? 1 << 1 : 0)
        }
        return { [weak self] in await self?.removeAVCCConsumer(id, broadcast: broadcast) }
    }

    private func removeAVCCConsumer(_ id: UUID, broadcast: AVCCBroadcast) async {
        guard avccBroadcast === broadcast else { return }
        avccSubscriptions.remove(id)
        await broadcast.unsubscribe(id)
        guard avccSubscriptions.isEmpty, avccBroadcast === broadcast else { return }
        let unsubscribe = unsubscribeAVCC
        avccBroadcast = nil; unsubscribeAVCC = nil
        await broadcast.stop()
        await unsubscribe?()
    }

    func stop() {
        if phase == .stopped { return }
        phase = .stopped
        Task { [frameCapture] in await frameCapture.stop() }
        if let broadcast = avccBroadcast { Task { await broadcast.stop() } }
        avccBroadcast = nil; unsubscribeAVCC = nil; avccSubscriptions.removeAll()
        consumers.removeAll()
    }
}

actor MJPEGEncoder: FrameEncoder {
    private let videoEncoder = VideoEncoder(quality: 0.7)
    private var lastImage: (UUID, Data)?

    init() {}

    func encode(_ frame: Frame) async throws -> Data {
        if let (id, data) = lastImage, id == frame.id { return data }
        let data = try await videoEncoder.encode(pixelBuffer: frame.pixelBuffer)
        lastImage = (frame.id, data)
        return data
    }
}

actor AVCCEncoder: FrameEncoder {
    private static let timeout: Duration = .milliseconds(500)

    let h264Encoder = H264Encoder(fps: 60)
    private var keyframes = AVCCKeyframeRequests()

    init() {}

    func requestKeyframe() { keyframes.request() }

    func encode(_ frame: Frame) async throws -> H264Encoder.Encoded? {
        // TODO: cancel after timeout using TaskGroup
        let generation = keyframes.generation
        let result = try await h264Encoder.encode(
            frame.pixelBuffer,
            forceKeyframe: keyframes.needed,
        )
        if let result, case .keyframe = result.kind { keyframes.encodedKeyframe(for: generation) }
        return result
    }

    deinit {
        Task { [h264Encoder] in await h264Encoder.stop() }
    }
}
