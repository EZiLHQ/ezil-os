import Foundation
import Virtualization

enum SmokeError: LocalizedError {
    case timeout
    case invalidReadyLine(String)
    case editorUnavailable
    case invalidResult(String)

    var errorDescription: String? {
        switch self {
        case .timeout: return "Timed out waiting for the virtual machine"
        case .invalidReadyLine(let line): return "Invalid ready line: \(line)"
        case .editorUnavailable: return "code-server health endpoint did not answer"
        case .invalidResult(let result): return "Unexpected guest result: \(result)"
        }
    }
}

final class BootSession {
    private let machine: VZVirtualMachine
    private let output: Pipe
    private var buffer = ""
    private var readyAddress: String?
    private var sawExpectedPersistence = false
    private let expectedPersistence: String
    private let semaphore = DispatchSemaphore(value: 0)

    init(runtime: URL, disk: URL, workspace: URL, expectedPersistence: String) throws {
        self.expectedPersistence = expectedPersistence
        let bootLoader = VZLinuxBootLoader(kernelURL: runtime.appendingPathComponent("vmlinuz"))
        bootLoader.initialRamdiskURL = runtime.appendingPathComponent("initrd.img")
        bootLoader.commandLine = "console=hvc0 root=/dev/vda rw init=/sbin/ezil-init quiet ezil.e2e=1 ezil.editor_password=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

        let configuration = VZVirtualMachineConfiguration()
        configuration.platform = VZGenericPlatformConfiguration()
        configuration.bootLoader = bootLoader
        configuration.cpuCount = 2
        configuration.memorySize = UInt64(4 * 1_024 * 1_024 * 1_024)
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment:
            try VZDiskImageStorageDeviceAttachment(url: disk, readOnly: false))]
        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]
        let share = VZVirtioFileSystemDeviceConfiguration(tag: "ezil-workspace")
        share.share = VZSingleDirectoryShare(directory: VZSharedDirectory(url: workspace, readOnly: false))
        configuration.directorySharingDevices = [share]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]

        let input = Pipe()
        output = Pipe()
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration()
        serial.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: input.fileHandleForReading,
            fileHandleForWriting: output.fileHandleForWriting
        )
        configuration.serialPorts = [serial]
        try configuration.validate()
        machine = VZVirtualMachine(configuration: configuration)
        output.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            self?.consume(String(decoding: data, as: UTF8.self))
        }
    }

    func run() throws {
        machine.start { [weak self] result in
            if case .failure(let error) = result {
                fputs("VM start failed: \(error)\n", stderr)
                self?.semaphore.signal()
            }
        }
        guard semaphore.wait(timeout: .now() + 120) == .success else { throw SmokeError.timeout }
        guard let address = readyAddress, sawExpectedPersistence else { throw SmokeError.timeout }
        let health = URL(string: "http://\(address):8443/healthz")!
        let result = try String(contentsOf: health, encoding: .utf8)
        guard result.contains("alive") else {
            throw SmokeError.editorUnavailable
        }
        guard machine.canRequestStop else { throw SmokeError.timeout }
        try machine.requestStop()
        let deadline = Date().addingTimeInterval(20)
        while machine.state != .stopped && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.1)
        }
        guard machine.state == .stopped else { throw SmokeError.timeout }
        output.fileHandleForReading.readabilityHandler = nil
    }

    private func consume(_ text: String) {
        fputs(text, stdout)
        buffer += text
        while let newline = buffer.firstIndex(of: "\n") {
            let line = String(buffer[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
            buffer.removeSubrange(...newline)
            if line.hasPrefix("EZIL_READY "), let field = line.split(separator: " ").first(where: { $0.hasPrefix("ip=") }) {
                readyAddress = String(field.dropFirst(3))
            }
            if line == "EZIL_E2E architecture=aarch64 persistence=\(expectedPersistence) code=10" {
                sawExpectedPersistence = true
            }
            if readyAddress != nil && sawExpectedPersistence { semaphore.signal() }
        }
    }
}

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: VMRuntimeSmoke <runtime-directory> <working-directory>\n", stderr)
    exit(2)
}

let fileManager = FileManager.default
let runtime = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let root = URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true)
let workspace = root.appendingPathComponent("workspace", isDirectory: true)
let disk = root.appendingPathComponent("runtime.img")
try fileManager.createDirectory(at: workspace, withIntermediateDirectories: true)
try fileManager.copyItem(at: runtime.appendingPathComponent("rootfs.img"), to: disk)

try BootSession(runtime: runtime, disk: disk, workspace: workspace, expectedPersistence: "first").run()
try BootSession(runtime: runtime, disk: disk, workspace: workspace, expectedPersistence: "persisted").run()
let result = try String(contentsOf: workspace.appendingPathComponent(".ezil-e2e-result"), encoding: .utf8)
guard result.contains("architecture=aarch64"), result.contains("persistence=persisted"), result.contains("code=10") else {
    throw SmokeError.invalidResult(result)
}
print("EZiL VM runtime smoke passed")
