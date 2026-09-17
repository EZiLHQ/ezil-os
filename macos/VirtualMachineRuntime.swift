import CryptoKit
import Combine
import Foundation
import Virtualization

struct RuntimeAssets: Sendable {
    let kernel: URL
    let initialRamdisk: URL
    let baseDisk: URL
}

enum VirtualMachineRuntimeError: LocalizedError {
    case appleSiliconRequired
    case runtimeMissing(String)
    case runtimeCorrupt(String)
    case virtualMachineDidNotStop

    var errorDescription: String? {
        switch self {
        case .appleSiliconRequired: return "This preview requires an Apple Silicon Mac."
        case .runtimeMissing(let file): return "The installer is incomplete: \(file) is missing."
        case .runtimeCorrupt(let file): return "The bundled runtime failed its integrity check: \(file)."
        case .virtualMachineDidNotStop: return "The local workspace did not stop cleanly."
        }
    }
}

@MainActor
final class VirtualMachineRuntime: ObservableObject {
    @Published private(set) var phase: RuntimePhase = .idle
    @Published private(set) var diagnosticLog = ""

    private var machine: VZVirtualMachine?
    private var outputPipe: Pipe?
    private var inputPipe: Pipe?
    private var serialBuffer = ""

    var editorURL: URL? {
        guard case .running(let ready) = phase else { return nil }
        var components = URLComponents()
        components.scheme = "http"
        components.host = ready.address
        components.port = ready.editorPort
        components.path = "/"
        components.queryItems = [URLQueryItem(name: "folder", value: "/workspace")]
        return components.url
    }

    var isActive: Bool {
        switch phase {
        case .preparing, .starting, .running, .stopping: return true
        case .idle, .failed: return false
        }
    }

    func start(workspace: WorkspaceRecord, store: WorkspaceStore) {
        guard !isActive else { return }
#if arch(arm64)
        phase = .preparing
        diagnosticLog = "Preparing your private workspace…\n"
        Task {
            do {
                let prepared = try await Self.prepareRuntime(workspace: workspace, store: store)
                try boot(
                    assets: prepared.assets,
                    disk: prepared.disk,
                    sharedDirectory: prepared.sharedDirectory,
                    editorPassword: prepared.editorPassword
                )
            } catch {
                fail(error)
            }
        }
#else
        fail(VirtualMachineRuntimeError.appleSiliconRequired)
#endif
    }

    func stop(completion: (() -> Void)? = nil) {
        guard let machine else {
            phase = .idle
            completion?()
            return
        }
        phase = .stopping
        do {
            guard machine.canRequestStop else { throw VirtualMachineRuntimeError.virtualMachineDidNotStop }
            try machine.requestStop()
            waitForStop(machine, attemptsRemaining: 100, completion: completion)
        } catch {
            machine.stop { [weak self, weak machine] _ in
                Task { @MainActor in
                    guard let self, self.machine === machine else { return }
                    self.releaseMachine()
                    self.fail(error)
                    completion?()
                }
            }
        }
    }

    private func waitForStop(
        _ target: VZVirtualMachine,
        attemptsRemaining: Int,
        completion: (() -> Void)?
    ) {
        guard machine === target else { return }
        if target.state == .stopped {
            releaseMachine()
            completion?()
            return
        }
        guard attemptsRemaining > 0 else {
            target.stop { [weak self, weak target] error in
                Task { @MainActor in
                    guard let self, self.machine === target else { return }
                    self.releaseMachine()
                    if let error { self.fail(error) }
                    completion?()
                }
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self, weak target] in
            guard let self, let target else { return }
            self.waitForStop(target, attemptsRemaining: attemptsRemaining - 1, completion: completion)
        }
    }

    private struct Prepared: Sendable {
        let assets: RuntimeAssets
        let disk: URL
        let sharedDirectory: URL
        let editorPassword: String
    }

    nonisolated private static func prepareRuntime(
        workspace: WorkspaceRecord,
        store: WorkspaceStore
    ) async throws -> Prepared {
        try await Task.detached(priority: .userInitiated) {
            guard let root = Bundle.main.resourceURL?.appendingPathComponent("runtime/vm", isDirectory: true) else {
                throw VirtualMachineRuntimeError.runtimeMissing("runtime/vm")
            }
            let manifestURL = root.appendingPathComponent("manifest.json")
            guard FileManager.default.fileExists(atPath: manifestURL.path) else {
                throw VirtualMachineRuntimeError.runtimeMissing("manifest.json")
            }
            let manifest = try JSONDecoder().decode(RuntimeManifest.self, from: Data(contentsOf: manifestURL))
            try manifest.validate()
            let assets = RuntimeAssets(
                kernel: root.appendingPathComponent("vmlinuz"),
                initialRamdisk: root.appendingPathComponent("initrd.img"),
                baseDisk: root.appendingPathComponent("rootfs.img")
            )
            for (url, expected) in [
                (assets.kernel, manifest.kernelSHA256),
                (assets.initialRamdisk, manifest.initrdSHA256),
                (assets.baseDisk, manifest.diskSHA256),
            ] {
                guard FileManager.default.fileExists(atPath: url.path) else {
                    throw VirtualMachineRuntimeError.runtimeMissing(url.lastPathComponent)
                }
                guard try sha256(url) == expected else {
                    throw VirtualMachineRuntimeError.runtimeCorrupt(url.lastPathComponent)
                }
            }
            let disk = store.diskURL(workspace.id)
            if !FileManager.default.fileExists(atPath: disk.path) {
                try FileManager.default.copyItem(at: assets.baseDisk, to: disk)
                try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: disk.path)
            }
            return Prepared(
                assets: assets,
                disk: disk,
                sharedDirectory: store.filesDirectory(workspace.id),
                editorPassword: workspace.editorPassword
            )
        }.value
    }

    private func boot(
        assets: RuntimeAssets,
        disk: URL,
        sharedDirectory: URL,
        editorPassword: String
    ) throws {
        let bootLoader = VZLinuxBootLoader(kernelURL: assets.kernel)
        bootLoader.initialRamdiskURL = assets.initialRamdisk
        bootLoader.commandLine = "console=hvc0 root=/dev/vda rw init=/sbin/ezil-init quiet ezil.editor_password=\(editorPassword)"

        let configuration = VZVirtualMachineConfiguration()
        configuration.platform = VZGenericPlatformConfiguration()
        configuration.bootLoader = bootLoader
        configuration.cpuCount = max(
            VZVirtualMachineConfiguration.minimumAllowedCPUCount,
            min(2, VZVirtualMachineConfiguration.maximumAllowedCPUCount)
        )
        configuration.memorySize = max(
            VZVirtualMachineConfiguration.minimumAllowedMemorySize,
            min(UInt64(4 * 1_024 * 1_024 * 1_024), VZVirtualMachineConfiguration.maximumAllowedMemorySize)
        )

        let diskAttachment = try VZDiskImageStorageDeviceAttachment(
            url: disk,
            readOnly: false,
            cachingMode: .automatic,
            synchronizationMode: .full
        )
        configuration.storageDevices = [VZVirtioBlockDeviceConfiguration(attachment: diskAttachment)]

        let network = VZVirtioNetworkDeviceConfiguration()
        network.attachment = VZNATNetworkDeviceAttachment()
        configuration.networkDevices = [network]
        configuration.entropyDevices = [VZVirtioEntropyDeviceConfiguration()]
        configuration.memoryBalloonDevices = [VZVirtioTraditionalMemoryBalloonDeviceConfiguration()]

        let directoryShare = VZVirtioFileSystemDeviceConfiguration(tag: "ezil-workspace")
        directoryShare.share = VZSingleDirectoryShare(
            directory: VZSharedDirectory(url: sharedDirectory, readOnly: false)
        )
        configuration.directorySharingDevices = [directoryShare]

        let incoming = Pipe()
        let outgoing = Pipe()
        let console = VZVirtioConsoleDeviceSerialPortConfiguration()
        console.attachment = VZFileHandleSerialPortAttachment(
            fileHandleForReading: incoming.fileHandleForReading,
            fileHandleForWriting: outgoing.fileHandleForWriting
        )
        configuration.serialPorts = [console]
        try configuration.validate()

        outputPipe = outgoing
        inputPipe = incoming
        outgoing.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            let text = String(decoding: data, as: UTF8.self)
            Task { @MainActor [weak self] in self?.consumeSerial(text) }
        }

        let virtualMachine = VZVirtualMachine(configuration: configuration)
        machine = virtualMachine
        phase = .starting
        appendDiagnostic("Starting the local ARM Linux workspace…\n")
        virtualMachine.start { [weak self, weak virtualMachine] result in
            Task { @MainActor in
                guard let self, self.machine === virtualMachine else { return }
                if case .failure(let error) = result { self.fail(error) }
            }
        }
    }

    private func consumeSerial(_ text: String) {
        appendDiagnostic(text)
        serialBuffer += text
        while let newline = serialBuffer.firstIndex(of: "\n") {
            let line = String(serialBuffer[..<newline]).trimmingCharacters(in: .whitespacesAndNewlines)
            serialBuffer.removeSubrange(...newline)
            guard line.hasPrefix("EZIL_READY ") else { continue }
            do {
                phase = .running(try RuntimeReady(line: line))
            } catch {
                fail(error)
            }
        }
    }

    private func appendDiagnostic(_ text: String) {
        diagnosticLog.append(text)
        if diagnosticLog.count > 100_000 {
            diagnosticLog.removeFirst(diagnosticLog.count - 100_000)
        }
    }

    private func fail(_ error: Error) {
        appendDiagnostic("ERROR: \(error.localizedDescription)\n")
        phase = .failed(error.localizedDescription)
    }

    private func releaseMachine() {
        outputPipe?.fileHandleForReading.readabilityHandler = nil
        outputPipe = nil
        inputPipe = nil
        machine = nil
        serialBuffer = ""
        phase = .idle
    }
}

private func sha256(_ url: URL) throws -> String {
    let handle = try FileHandle(forReadingFrom: url)
    defer { try? handle.close() }
    var hasher = SHA256()
    while true {
        let data = try handle.read(upToCount: 1_048_576) ?? Data()
        if data.isEmpty { break }
        hasher.update(data: data)
    }
    return hasher.finalize().map { String(format: "%02x", $0) }.joined()
}
