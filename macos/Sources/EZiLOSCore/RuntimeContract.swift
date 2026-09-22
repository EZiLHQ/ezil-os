import Foundation

public struct RuntimeManifest: Codable, Equatable, Sendable {
    public let formatVersion: Int
    public let architecture: String
    public let minimumMacOS: String
    public let kernelSHA256: String
    public let initrdSHA256: String
    public let diskSHA256: String
    public let codeServerVersion: String

    public init(
        formatVersion: Int,
        architecture: String,
        minimumMacOS: String,
        kernelSHA256: String,
        initrdSHA256: String,
        diskSHA256: String,
        codeServerVersion: String
    ) {
        self.formatVersion = formatVersion
        self.architecture = architecture
        self.minimumMacOS = minimumMacOS
        self.kernelSHA256 = kernelSHA256
        self.initrdSHA256 = initrdSHA256
        self.diskSHA256 = diskSHA256
        self.codeServerVersion = codeServerVersion
    }

    public func validate() throws {
        guard formatVersion == 1 else { throw RuntimeContractError.unsupportedFormat }
        guard architecture == "arm64" else { throw RuntimeContractError.unsupportedArchitecture }
        for digest in [kernelSHA256, initrdSHA256, diskSHA256] {
            guard digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else {
                throw RuntimeContractError.invalidDigest
            }
        }
    }
}

public enum RuntimeContractError: LocalizedError, Equatable {
    case unsupportedFormat
    case unsupportedArchitecture
    case invalidDigest
    case invalidReadyMessage

    public var errorDescription: String? {
        switch self {
        case .unsupportedFormat: return "This EZiL runtime format is not supported."
        case .unsupportedArchitecture: return "This build requires an Apple Silicon runtime."
        case .invalidDigest: return "The bundled runtime manifest is invalid."
        case .invalidReadyMessage: return "The local runtime returned an invalid ready message."
        }
    }
}

public struct RuntimeReady: Equatable, Sendable {
    public let address: String
    public let editorPort: Int

    public init(address: String, editorPort: Int) {
        self.address = address
        self.editorPort = editorPort
    }

    public init(line: String) throws {
        let fields = line.split(separator: " ")
        guard fields.first == "EZIL_READY" else { throw RuntimeContractError.invalidReadyMessage }
        let pairs = Dictionary(uniqueKeysWithValues: fields.dropFirst().compactMap { field -> (String, String)? in
            let values = field.split(separator: "=", maxSplits: 1)
            guard values.count == 2 else { return nil }
            return (String(values[0]), String(values[1]))
        })
        guard let address = pairs["ip"], isPrivateIPv4(address),
              let portText = pairs["editor"], let port = Int(portText), (1...65_535).contains(port) else {
            throw RuntimeContractError.invalidReadyMessage
        }
        self.address = address
        self.editorPort = port
    }
}

private func isPrivateIPv4(_ value: String) -> Bool {
    let octets = value.split(separator: ".").compactMap { Int($0) }
    guard octets.count == 4, octets.allSatisfy({ (0...255).contains($0) }) else { return false }
    return octets[0] == 10
        || (octets[0] == 172 && (16...31).contains(octets[1]))
        || (octets[0] == 192 && octets[1] == 168)
}

public enum RuntimePhase: Equatable, Sendable {
    case idle
    case preparing
    case starting
    case running(RuntimeReady)
    case stopping
    case failed(String)
}

public enum RuntimeEvent: Equatable, Sendable {
    case prepare
    case prepared
    case ready(RuntimeReady)
    case stop
    case stopped
    case fail(String)
}

public struct RuntimeStateMachine: Sendable {
    public private(set) var phase: RuntimePhase = .idle

    public init() {}

    @discardableResult
    public mutating func apply(_ event: RuntimeEvent) -> Bool {
        switch (phase, event) {
        case (.idle, .prepare), (.failed, .prepare): phase = .preparing
        case (.preparing, .prepared): phase = .starting
        case (.starting, .ready(let ready)): phase = .running(ready)
        case (.preparing, .stop), (.starting, .stop), (.running, .stop): phase = .stopping
        case (.stopping, .stopped): phase = .idle
        case (_, .fail(let message)): phase = .failed(message)
        default: return false
        }
        return true
    }
}
