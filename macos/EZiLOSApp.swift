import AppKit
import SwiftUI
import WebKit

private let desktopURL = URL(string: "http://127.0.0.1:7080/os")!
private let vsCodeBundleIdentifier = "com.microsoft.VSCode"

enum LaunchStatus: Equatable {
    case stopped
    case starting
    case running
    case stopping
    case failed(Int32)

    var label: String {
        switch self {
        case .stopped: return "Stopped"
        case .starting: return "Starting…"
        case .running: return "Running"
        case .stopping: return "Stopping…"
        case .failed(let code): return "Stopped with error (exit \(code))"
        }
    }

    var color: Color {
        switch self {
        case .running: return .green
        case .starting, .stopping: return .orange
        case .failed: return .red
        case .stopped: return .secondary
        }
    }
}

final class DesktopController: ObservableObject {
    static let shared = DesktopController()

    @Published var status: LaunchStatus = .stopped
    @Published var log = "EZiL OS is ready to start.\n"
    @Published var workspacePath: String {
        didSet { UserDefaults.standard.set(workspacePath, forKey: "workspacePath") }
    }
    @Published var portOffset: String {
        didSet { UserDefaults.standard.set(portOffset, forKey: "portOffset") }
    }
    @Published var imageOverride: String {
        didSet { UserDefaults.standard.set(imageOverride, forKey: "imageOverride") }
    }

    private var process: Process?
    private var outputPipe: Pipe?
    private var stopCompletion: (() -> Void)?

    var isActive: Bool {
        guard let process else { return false }
        return process.isRunning
    }

    private init() {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        workspacePath = UserDefaults.standard.string(forKey: "workspacePath")
            ?? "\(home)/EZiL-OS Workspace"
        portOffset = UserDefaults.standard.string(forKey: "portOffset") ?? "10000"
        imageOverride = UserDefaults.standard.string(forKey: "imageOverride") ?? ""
    }

    func chooseWorkspace() {
        let panel = NSOpenPanel()
        panel.title = "Choose the folder shared with EZiL OS"
        panel.prompt = "Use This Folder"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: workspacePath, isDirectory: true)
        if panel.runModal() == .OK, let url = panel.url {
            workspacePath = url.path
        }
    }

    func revealWorkspace() {
        let url = URL(fileURLWithPath: workspacePath, isDirectory: true)
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        NSWorkspace.shared.open(url)
    }

    func openWorkspaceInVSCode() {
        let folder = URL(fileURLWithPath: workspacePath, isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        } catch {
            appendLog("ERROR: could not create the Mac workspace: \(error.localizedDescription)\n")
            return
        }

        guard let application = NSWorkspace.shared.urlForApplication(
            withBundleIdentifier: vsCodeBundleIdentifier
        ) else {
            appendLog("ERROR: native Visual Studio Code is not installed on this Mac. The Linux VS Code inside the local Docker desktop is still available after Start Desktop.\n")
            return
        }

        let configuration = NSWorkspace.OpenConfiguration()
        configuration.activates = true
        NSWorkspace.shared.open(
            [folder],
            withApplicationAt: application,
            configuration: configuration
        ) { [weak self] _, error in
            guard let error else { return }
            DispatchQueue.main.async {
                self?.appendLog("ERROR: could not open the workspace in native Visual Studio Code: \(error.localizedDescription)\n")
            }
        }
    }

    func openInBrowser() {
        NSWorkspace.shared.open(desktopURL)
    }

    func start() {
        guard !isActive else { return }
        guard let resourceRoot = Bundle.main.resourceURL else {
            status = .failed(2)
            appendLog("ERROR: application resources are unavailable.\n")
            return
        }

        let runtimeRoot = resourceRoot.appendingPathComponent("runtime", isDirectory: true)
        let launcher = runtimeRoot.appendingPathComponent("deploy/launcher/ezil-os.sh")
        guard FileManager.default.isExecutableFile(atPath: launcher.path) else {
            status = .failed(2)
            appendLog("ERROR: bundled launcher is missing at \(launcher.path)\n")
            return
        }

        guard Int(portOffset.trimmingCharacters(in: .whitespaces)) != nil else {
            status = .failed(2)
            appendLog("ERROR: port offset must be an integer.\n")
            return
        }

        let workspace = URL(fileURLWithPath: workspacePath, isDirectory: true)
        let state = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/EZiL OS", isDirectory: true)
        do {
            try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
            try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
        } catch {
            status = .failed(2)
            appendLog("ERROR: could not create a local folder: \(error.localizedDescription)\n")
            return
        }

        log = "Starting EZiL OS…\nShared Mac folder: \(workspace.path)\nContainer folder: /home/neko/project\n\n"
        status = .starting

        let task = Process()
        let pipe = Pipe()
        task.executableURL = URL(fileURLWithPath: "/bin/bash")
        task.arguments = [launcher.path, "--no-browser"]
        task.currentDirectoryURL = runtimeRoot
        task.standardOutput = pipe
        task.standardError = pipe

        var environment = ProcessInfo.processInfo.environment
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        let guiPaths = [
            "\(home)/.bun/bin",
            "\(home)/.docker/bin",
            "/Applications/Docker.app/Contents/Resources/bin",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        environment["PATH"] = (guiPaths + [environment["PATH"] ?? ""])
            .filter { !$0.isEmpty }
            .joined(separator: ":")
        environment["EZIL_LOCAL_WORKSPACE"] = workspace.path
        environment["EZIL_LOCAL_STATE_DIR"] = state.path
        environment["EZIL_LOCAL_PORT"] = "7080"
        environment["EZIL_LOCAL_PORT_OFFSET"] = portOffset.trimmingCharacters(in: .whitespaces)
        let override = imageOverride.trimmingCharacters(in: .whitespacesAndNewlines)
        if !override.isEmpty {
            environment["EZIL_LAUNCHER_IMAGE"] = override
        }
        task.environment = environment

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let data = handle.availableData
            guard !data.isEmpty else {
                handle.readabilityHandler = nil
                return
            }
            let text = String(decoding: data, as: UTF8.self)
            DispatchQueue.main.async {
                self?.appendLog(text)
                if text.contains("EZiL OS is up:") {
                    self?.status = .running
                }
            }
        }

        task.terminationHandler = { [weak self, weak task] finished in
            DispatchQueue.main.async {
                guard let self else { return }
                self.outputPipe?.fileHandleForReading.readabilityHandler = nil
                self.outputPipe = nil
                if self.process === task {
                    self.process = nil
                }
                if case .stopping = self.status {
                    self.status = .stopped
                } else if finished.terminationStatus == 0 {
                    self.status = .stopped
                } else {
                    self.status = .failed(finished.terminationStatus)
                }
                let completion = self.stopCompletion
                self.stopCompletion = nil
                completion?()
            }
        }

        do {
            try task.run()
            process = task
            outputPipe = pipe
        } catch {
            pipe.fileHandleForReading.readabilityHandler = nil
            status = .failed(2)
            appendLog("ERROR: could not launch EZiL OS: \(error.localizedDescription)\n")
        }
    }

    func stop(completion: (() -> Void)? = nil) {
        guard let task = process, task.isRunning else {
            status = .stopped
            completion?()
            return
        }
        status = .stopping
        stopCompletion = completion
        appendLog("\nStopping EZiL OS and removing its desktop container…\n")
        task.terminate()

        // The launcher normally handles SIGTERM immediately and removes only
        // the container it created. Never keep the app's quit request hanging
        // forever if Docker itself has stopped responding.
        DispatchQueue.main.asyncAfter(deadline: .now() + 10) { [weak self, weak task] in
            guard let self, let task, task.isRunning else { return }
            task.interrupt()
            let completion = self.stopCompletion
            self.stopCompletion = nil
            completion?()
        }
    }

    private func appendLog(_ text: String) {
        log.append(text)
        // Bound the UI buffer while leaving the launcher's full diagnostics
        // visible for ordinary failures.
        if log.count > 100_000 {
            log.removeFirst(log.count - 100_000)
        }
    }
}

struct DesktopWebView: NSViewRepresentable {
    let url: URL
    let enabled: Bool

    final class Coordinator {
        var loaded = false
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .default()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.allowsMagnification = true
        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard enabled else {
            if context.coordinator.loaded {
                context.coordinator.loaded = false
                webView.stopLoading()
                webView.loadHTMLString("", baseURL: nil)
            }
            return
        }
        guard !context.coordinator.loaded else { return }
        context.coordinator.loaded = true
        webView.load(URLRequest(url: url))
    }
}

struct SetupView: View {
    @ObservedObject var controller: DesktopController

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Local Docker desktop")
                        .font(.title2.bold())
                    Text("Everything runs on this Mac. Docker hosts Linux VS Code and Chrome; no cloud desktop is used.")
                        .foregroundStyle(.secondary)
                }
                Spacer()
                Circle()
                    .fill(controller.status.color)
                    .frame(width: 10, height: 10)
                Text(controller.status.label)
                    .font(.headline)
            }

            GroupBox("Local workspace") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        TextField("Mac folder", text: $controller.workspacePath)
                            .textFieldStyle(.roundedBorder)
                            .disabled(controller.isActive)
                        Button("Choose…") { controller.chooseWorkspace() }
                            .disabled(controller.isActive)
                        Button("Show in Finder") { controller.revealWorkspace() }
                        Button("Open in Mac VS Code") { controller.openWorkspaceInVSCode() }
                    }
                    Text("This is one set of files, not a copy queue: Docker bind-mounts this Mac folder at /home/neko/project. Linux VS Code, native Mac VS Code, Finder, and your terminal all edit the same files.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                }
                .padding(.top, 4)
            }

            GroupBox("What runs where") {
                VStack(alignment: .leading, spacing: 6) {
                    Label("Native Mac: this SwiftUI app, its embedded WebKit view, and optional native VS Code.", systemImage: "macbook")
                    Label("Local Docker: the EZiL Linux desktop, Linux VS Code, and Linux Chrome.", systemImage: "shippingbox")
                    Label("Network: the desktop and all published ports stay on 127.0.0.1.", systemImage: "lock.shield")
                }
                .font(.callout)
                .padding(.top, 4)
            }

            DisclosureGroup("Advanced") {
                Grid(alignment: .leading, horizontalSpacing: 12, verticalSpacing: 10) {
                    GridRow {
                        Text("Container port offset")
                        TextField("10000", text: $controller.portOffset)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 120)
                            .disabled(controller.isActive)
                    }
                    GridRow {
                        Text("Desktop image override")
                        TextField("Optional image:tag", text: $controller.imageOverride)
                            .textFieldStyle(.roundedBorder)
                            .disabled(controller.isActive)
                    }
                }
                .padding(.top, 8)
            }

            HStack {
                Button(controller.isActive ? "Stop Desktop" : "Start Desktop") {
                    controller.isActive ? controller.stop() : controller.start()
                }
                .keyboardShortcut(.defaultAction)

                Button("Open Local Desktop in Mac Browser") { controller.openInBrowser() }
                    .disabled(controller.status != .running)

                Spacer()
                Text("Bedrock and Azure credentials are never bundled. Configure a separate developer identity after install.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
                    .frame(maxWidth: 430)
            }

            GroupBox("Launcher log") {
                ScrollView {
                    Text(controller.log)
                        .font(.system(.caption, design: .monospaced))
                        .textSelection(.enabled)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(6)
                }
                .frame(minHeight: 220)
            }
        }
        .padding(20)
    }
}

struct RootView: View {
    @ObservedObject var controller: DesktopController
    @State private var selectedTab = 1

    var body: some View {
        TabView(selection: $selectedTab) {
            ZStack {
                DesktopWebView(url: desktopURL, enabled: controller.status == .running)
                if controller.status != .running {
                    VStack(spacing: 12) {
                        Image(systemName: "display")
                            .font(.system(size: 48))
                            .foregroundStyle(.secondary)
                        Text("Start the desktop from Setup & Logs")
                            .font(.title3)
                        Text(controller.status.label)
                            .foregroundStyle(controller.status.color)
                    }
                }
            }
            .tabItem { Label("Desktop", systemImage: "display") }
            .tag(0)

            SetupView(controller: controller)
                .tabItem { Label("Setup & Logs", systemImage: "gearshape") }
                .tag(1)
        }
        .onChange(of: controller.status) { newStatus in
            if newStatus == .running {
                selectedTab = 0
            }
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let controller = DesktopController.shared
        guard controller.isActive else { return .terminateNow }
        controller.stop {
            sender.reply(toApplicationShouldTerminate: true)
        }
        return .terminateLater
    }
}

@main
struct EZiLOSApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var controller = DesktopController.shared

    var body: some Scene {
        WindowGroup("EZiL OS") {
            RootView(controller: controller)
                .frame(minWidth: 880, minHeight: 620)
        }
        .defaultSize(width: 1280, height: 820)
    }
}
