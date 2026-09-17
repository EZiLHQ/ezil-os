import AppKit
import SwiftUI
import WebKit

enum SidebarDestination: String, CaseIterable, Identifiable {
    case home = "Home"
    case code = "Code"
    case browser = "Browser"
    case files = "Files"
    case settings = "Settings"

    var id: String { rawValue }
    var symbol: String {
        switch self {
        case .home: return "square.grid.2x2"
        case .code: return "chevron.left.forwardslash.chevron.right"
        case .browser: return "globe"
        case .files: return "folder"
        case .settings: return "gearshape"
        }
    }
}

@MainActor
final class AppController: ObservableObject {
    static let shared = AppController()

    @Published var profile: GuestProfile?
    @Published var workspace: WorkspaceRecord?
    @Published var destination: SidebarDestination = .home
    @Published var message: String?
    @Published var showingRemoveConfirmation = false

    let runtime = VirtualMachineRuntime()
    let store: WorkspaceStore

    private init() {
        let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("EZiL OS", isDirectory: true)
        store = WorkspaceStore(root: support)
        do {
            profile = try store.loadOrCreateGuestProfile()
            workspace = try store.listWorkspaces().first
        } catch {
            message = error.localizedDescription
        }
    }

    func continueAsGuest() {
        do {
            profile = try store.loadOrCreateGuestProfile()
            if workspace == nil { workspace = try store.createWorkspace() }
            startWorkspace()
        } catch {
            message = error.localizedDescription
        }
    }

    func startWorkspace() {
        guard let current = workspace else { return }
        do {
            workspace = try store.touch(current)
            if let workspace { runtime.start(workspace: workspace, store: store) }
        } catch {
            message = error.localizedDescription
        }
    }

    func importFiles() {
        guard let workspace else { return }
        let panel = NSOpenPanel()
        panel.title = "Copy files into \(workspace.name)"
        panel.prompt = "Import"
        panel.canChooseDirectories = true
        panel.canChooseFiles = true
        panel.allowsMultipleSelection = true
        panel.resolvesAliases = false
        guard panel.runModal() == .OK else { return }
        do {
            try store.importItems(panel.urls, into: workspace)
            message = "Imported \(panel.urls.count) item\(panel.urls.count == 1 ? "" : "s")."
        } catch {
            message = error.localizedDescription
        }
    }

    func exportWorkspace() {
        guard let workspace else { return }
        let panel = NSOpenPanel()
        panel.title = "Choose an export destination"
        panel.prompt = "Export Here"
        panel.canChooseDirectories = true
        panel.canChooseFiles = false
        panel.canCreateDirectories = true
        guard panel.runModal() == .OK, let destination = panel.url else { return }
        do {
            let children = try FileManager.default.contentsOfDirectory(
                at: store.filesDirectory(workspace.id),
                includingPropertiesForKeys: nil
            )
            for child in children {
                _ = try store.exportItem(relativePath: child.lastPathComponent, from: workspace, to: destination)
            }
            message = "Exported \(children.count) item\(children.count == 1 ? "" : "s")."
        } catch {
            message = error.localizedDescription
        }
    }

    func revealManagedFiles() {
        guard let workspace else { return }
        NSWorkspace.shared.activateFileViewerSelecting([store.filesDirectory(workspace.id)])
    }

    func removeCurrentWorkspace() {
        guard let workspace else { return }
        let record = workspace
        runtime.stop { [weak self] in
            guard let self else { return }
            WKWebsiteDataStore.remove(forIdentifier: record.browserProfileID) { error in
                Task { @MainActor in
                    if let error { self.message = "Browser data could not be removed: \(error.localizedDescription)" }
                    do {
                        try self.store.removeWorkspace(record)
                        self.workspace = nil
                        self.destination = .home
                    } catch {
                        self.message = error.localizedDescription
                    }
                }
            }
        }
    }
}

struct ProfiledWebView: NSViewRepresentable {
    let url: URL?
    let profileID: UUID?
    var editorPassword: String? = nil

    final class Coordinator { var lastURL: URL? }
    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        if let profileID {
            configuration.websiteDataStore = WKWebsiteDataStore(forIdentifier: profileID)
        } else {
            configuration.websiteDataStore = .nonPersistent()
        }
        if let editorPassword {
            let escaped = editorPassword.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "\"", with: "\\\"")
            let script = """
            (() => {
              const input = document.querySelector('input[name="password"]');
              if (!input || !input.form) return;
              input.value = "\(escaped)";
              input.form.requestSubmit();
            })();
            """
            configuration.userContentController.addUserScript(
                WKUserScript(source: script, injectionTime: .atDocumentEnd, forMainFrameOnly: true)
            )
        }
        let view = WKWebView(frame: .zero, configuration: configuration)
        view.allowsMagnification = true
        return view
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.lastURL != url else { return }
        context.coordinator.lastURL = url
        guard let url else {
            webView.loadHTMLString("", baseURL: nil)
            return
        }
        webView.load(URLRequest(url: url, cachePolicy: .reloadRevalidatingCacheData, timeoutInterval: 30))
    }
}

struct WelcomeView: View {
    @ObservedObject var controller: AppController

    var body: some View {
        VStack(spacing: 22) {
            Image(systemName: "circle.grid.2x2.fill")
                .font(.system(size: 56, weight: .light))
                .foregroundStyle(.tint)
            VStack(spacing: 8) {
                Text("EZiL OS").font(.largeTitle.bold())
                Text("A private development workspace on this Mac.")
                    .font(.title3)
                    .foregroundStyle(.secondary)
            }
            Button("Continue as Guest") { controller.continueAsGuest() }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .keyboardShortcut(.defaultAction)
            Text("No account. No workspace upload. You can remove the workspace at any time.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 430)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(40)
    }
}

struct PreparingView: View {
    @ObservedObject var runtime: VirtualMachineRuntime

    var body: some View {
        VStack(spacing: 18) {
            ProgressView().controlSize(.large)
            Text("Preparing your workspace…").font(.title2.weight(.semibold))
            Text("Your editor, terminal, tools, and files are starting locally.")
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct HomeView: View {
    @ObservedObject var controller: AppController
    private let columns = [GridItem(.adaptive(minimum: 150), spacing: 18)]

    var body: some View {
        VStack(alignment: .leading, spacing: 28) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Welcome to EZiL OS").font(.largeTitle.bold())
                Text("Everything you create here stays in this workspace until you export it.")
                    .foregroundStyle(.secondary)
            }
            LazyVGrid(columns: columns, spacing: 18) {
                appButton("Code", symbol: "chevron.left.forwardslash.chevron.right", destination: .code)
                appButton("Browser", symbol: "globe", destination: .browser)
                appButton("Files", symbol: "folder", destination: .files)
                appButton("Settings", symbol: "gearshape", destination: .settings)
            }
            Spacer()
        }
        .padding(38)
    }

    private func appButton(_ title: String, symbol: String, destination: SidebarDestination) -> some View {
        Button { controller.destination = destination } label: {
            VStack(spacing: 14) {
                Image(systemName: symbol).font(.system(size: 34, weight: .medium))
                Text(title).font(.headline)
            }
            .frame(maxWidth: .infinity, minHeight: 120)
        }
        .buttonStyle(.plain)
        .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18))
    }
}

struct BrowserWorkspaceView: View {
    let profileID: UUID
    @State private var address = "https://example.com"
    @State private var url = URL(string: "https://example.com")

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                Image(systemName: "lock.shield")
                    .foregroundStyle(.secondary)
                    .help("Separate EZiL browser profile")
                TextField("Search or enter a website", text: $address)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { navigate() }
                Button("Go") { navigate() }.keyboardShortcut(.defaultAction)
            }
            .padding(10)
            Divider()
            ProfiledWebView(url: url, profileID: profileID)
        }
    }

    private func navigate() {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = trimmed.contains("://") ? trimmed : "https://\(trimmed)"
        if let parsed = URL(string: candidate), ["http", "https"].contains(parsed.scheme?.lowercased() ?? "") {
            url = parsed
        }
    }
}

struct FilesView: View {
    @ObservedObject var controller: AppController

    var body: some View {
        VStack(spacing: 18) {
            Image(systemName: "folder.badge.gearshape").font(.system(size: 48)).foregroundStyle(.tint)
            Text("Workspace Files").font(.title2.bold())
            Text("Import makes a private copy. Export is the only action that writes a project back outside EZiL OS.")
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
            HStack {
                Button("Import Files…") { controller.importFiles() }.buttonStyle(.borderedProminent)
                Button("Export Workspace…") { controller.exportWorkspace() }
                Button("Show Managed Files") { controller.revealManagedFiles() }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(32)
    }
}

struct SettingsView: View {
    @ObservedObject var controller: AppController
    @ObservedObject var runtime: VirtualMachineRuntime
    @State private var showDiagnostics = false

    var body: some View {
        Form {
            Section("Workspace") {
                LabeledContent("Profile", value: "Local guest")
                LabeledContent("Runtime", value: runtimeLabel)
                LabeledContent("Architecture", value: "Apple Silicon · ARM Linux")
            }
            Section("Data") {
                Text("EZiL stores this workspace under your Application Support folder. Exported files are never removed by workspace cleanup.")
                    .foregroundStyle(.secondary)
                Button("Remove Workspace…", role: .destructive) { controller.showingRemoveConfirmation = true }
            }
            Section("Diagnostics") {
                DisclosureGroup("Runtime log", isExpanded: $showDiagnostics) {
                    ScrollView {
                        Text(runtime.diagnosticLog.isEmpty ? "No diagnostics yet." : runtime.diagnosticLog)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(minHeight: 180)
                }
            }
        }
        .formStyle(.grouped)
        .confirmationDialog("Remove this workspace?", isPresented: $controller.showingRemoveConfirmation, titleVisibility: .visible) {
            Button("Remove Workspace", role: .destructive) { controller.removeCurrentWorkspace() }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This removes the runtime disk, editor settings, browser profile, and managed files. Files you exported remain where you saved them.")
        }
    }

    private var runtimeLabel: String {
        switch runtime.phase {
        case .idle: return "Stopped"
        case .preparing: return "Preparing"
        case .starting: return "Starting"
        case .running: return "Running locally"
        case .stopping: return "Stopping"
        case .failed: return "Needs attention"
        }
    }
}

struct WorkspaceShell: View {
    @ObservedObject var controller: AppController
    @ObservedObject var runtime: VirtualMachineRuntime

    var body: some View {
        NavigationSplitView {
            List(SidebarDestination.allCases, selection: $controller.destination) { item in
                Label(item.rawValue, systemImage: item.symbol).tag(item)
            }
            .navigationSplitViewColumnWidth(min: 170, ideal: 190)
            .safeAreaInset(edge: .bottom) {
                if let workspace = controller.workspace {
                    Text(workspace.name).font(.caption).foregroundStyle(.secondary).lineLimit(1).padding()
                }
            }
        } detail: { content }
        .alert("EZiL OS", isPresented: Binding(
            get: { controller.message != nil },
            set: { if !$0 { controller.message = nil } }
        )) {
            Button("OK") { controller.message = nil }
        } message: {
            Text(controller.message ?? "")
        }
    }

    @ViewBuilder private var content: some View {
        switch controller.destination {
        case .home:
            HomeView(controller: controller)
        case .code:
            if let editorURL = runtime.editorURL {
                ProfiledWebView(
                    url: editorURL,
                    profileID: nil,
                    editorPassword: controller.workspace?.editorPassword
                )
            } else if case .failed(let message) = runtime.phase {
                ContentUnavailableView {
                    Label("Workspace couldn’t start", systemImage: "exclamationmark.triangle")
                } description: { Text(message) } actions: { Button("Try Again") { controller.startWorkspace() } }
            } else {
                PreparingView(runtime: runtime)
            }
        case .browser:
            if let id = controller.workspace?.browserProfileID { BrowserWorkspaceView(profileID: id) }
        case .files:
            FilesView(controller: controller)
        case .settings:
            SettingsView(controller: controller, runtime: runtime)
        }
    }
}

struct RootView: View {
    @ObservedObject var controller: AppController
    @ObservedObject var runtime: VirtualMachineRuntime

    var body: some View {
        Group {
            if controller.workspace == nil {
                WelcomeView(controller: controller)
            } else if runtime.phase == .preparing || runtime.phase == .starting {
                PreparingView(runtime: runtime)
            } else {
                WorkspaceShell(controller: controller, runtime: runtime)
            }
        }
        .onAppear {
            if controller.workspace != nil, runtime.phase == .idle { controller.startWorkspace() }
        }
        .onChange(of: runtime.phase) { phase in
            if case .running = phase { controller.destination = .home }
        }
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        let runtime = AppController.shared.runtime
        guard runtime.isActive else { return .terminateNow }
        runtime.stop { sender.reply(toApplicationShouldTerminate: true) }
        return .terminateLater
    }
}

@main
struct EZiLOSApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var controller = AppController.shared

    var body: some Scene {
        WindowGroup("EZiL OS") {
            RootView(controller: controller, runtime: controller.runtime)
                .frame(minWidth: 980, minHeight: 680)
        }
        .defaultSize(width: 1280, height: 820)
    }
}
