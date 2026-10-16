// Copyright (c) 2026 Peter Abu. MIT licensed; see ../LICENSE.
// Write inside the simulator to avoid Xcode 27's no-op `simctl pbcopy`.
import Foundation
import UIKit

let data = FileHandle.standardInput.readDataToEndOfFile()
guard let text = String(data: data, encoding: .utf8) else {
    fputs("Pasteboard input must be UTF-8.\n", stderr)
    exit(64)
}
UIPasteboard.general.string = text
// UIKit's IPC write outlives the setter. Give it time to publish before this
// short-lived command exits; the caller verifies it through `simctl pbpaste`.
RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
_ = UIPasteboard.general.string
