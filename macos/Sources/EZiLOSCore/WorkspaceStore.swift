import Foundation

public struct GuestProfile: Codable, Equatable, Sendable {
    public let id: UUID
    public let createdAt: Date

    public init(id: UUID = UUID(), createdAt: Date = Date()) {
        self.id = id
        self.createdAt = createdAt
    }
}

public struct WorkspaceRecord: Codable, Equatable, Identifiable, Sendable {
    public let id: UUID
    public var name: String
    public let browserProfileID: UUID
    /** Per-workspace credential for the editor endpoint on the private VM network. */
    public let editorPassword: String
    public let createdAt: Date
    public var lastOpenedAt: Date

    public init(
        id: UUID = UUID(),
        name: String,
        browserProfileID: UUID = UUID(),
        editorPassword: String = UUID().uuidString.replacingOccurrences(of: "-", with: "")
            + UUID().uuidString.replacingOccurrences(of: "-", with: ""),
        createdAt: Date = Date(),
        lastOpenedAt: Date = Date()
    ) {
        self.id = id
        self.name = name
        self.browserProfileID = browserProfileID
        self.editorPassword = editorPassword
        self.createdAt = createdAt
        self.lastOpenedAt = lastOpenedAt
    }
}

public enum WorkspaceStoreError: LocalizedError, Equatable {
    case invalidName
    case invalidRelativePath
    case symbolicLinkNotAllowed(String)
    case importLimitExceeded
    case destinationExists(String)
    case workspaceNotFound
    case unsafeOwnedPath

    public var errorDescription: String? {
        switch self {
        case .invalidName: return "Choose a workspace name containing a letter or number."
        case .invalidRelativePath: return "The requested file is outside this workspace."
        case .symbolicLinkNotAllowed(let name): return "Symbolic links cannot be imported: \(name)"
        case .importLimitExceeded: return "The import is larger than this workspace allows."
        case .destinationExists(let name): return "A file named \(name) already exists in this workspace."
        case .workspaceNotFound: return "The workspace no longer exists."
        case .unsafeOwnedPath: return "EZiL refused to modify a path it does not own."
        }
    }
}

public struct ImportLimits: Equatable, Sendable {
    public var maximumFiles: Int
    public var maximumBytes: Int64

    public init(maximumFiles: Int = 100_000, maximumBytes: Int64 = 20 * 1_024 * 1_024 * 1_024) {
        self.maximumFiles = maximumFiles
        self.maximumBytes = maximumBytes
    }
}

public final class WorkspaceStore: @unchecked Sendable {
    public static let defaultExpandedDiskSize: UInt64 = 16 * 1_024 * 1_024 * 1_024

    public let root: URL
    public let workspacesRoot: URL
    private let fileManager: FileManager
    private let encoder: JSONEncoder
    private let decoder: JSONDecoder

    public init(root: URL, fileManager: FileManager = .default) {
        self.root = root.standardizedFileURL
        self.workspacesRoot = self.root.appendingPathComponent("workspaces", isDirectory: true)
        self.fileManager = fileManager
        self.encoder = JSONEncoder()
        self.decoder = JSONDecoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        // Foundation's ISO-8601 strategy drops fractional seconds on some
        // platforms. Deferred dates preserve an exact record across reloads.
        encoder.dateEncodingStrategy = .deferredToDate
        decoder.dateDecodingStrategy = .deferredToDate
    }

    public func prepare() throws {
        try createPrivateDirectory(root)
        try createPrivateDirectory(workspacesRoot)
    }

    public func loadOrCreateGuestProfile() throws -> GuestProfile {
        try prepare()
        let url = root.appendingPathComponent("guest-profile.json")
        if fileManager.fileExists(atPath: url.path) {
            return try decoder.decode(GuestProfile.self, from: Data(contentsOf: url))
        }
        let profile = GuestProfile()
        try writeJSON(profile, to: url)
        return profile
    }

    public func listWorkspaces() throws -> [WorkspaceRecord] {
        try prepare()
        return try fileManager.contentsOfDirectory(
            at: workspacesRoot,
            includingPropertiesForKeys: [.isDirectoryKey],
            options: [.skipsHiddenFiles]
        ).compactMap { directory in
            let recordURL = directory.appendingPathComponent("workspace.json")
            guard fileManager.fileExists(atPath: recordURL.path) else { return nil }
            return try decoder.decode(WorkspaceRecord.self, from: Data(contentsOf: recordURL))
        }.sorted { $0.lastOpenedAt > $1.lastOpenedAt }
    }

    public func createWorkspace(named requestedName: String = "My Workspace") throws -> WorkspaceRecord {
        try prepare()
        let name = requestedName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard name.rangeOfCharacter(from: .alphanumerics) != nil, name.count <= 80 else {
            throw WorkspaceStoreError.invalidName
        }
        let record = WorkspaceRecord(name: name)
        let directory = workspaceDirectory(record.id)
        try createPrivateDirectory(directory)
        try createPrivateDirectory(filesDirectory(record.id))
        try writeJSON(record, to: recordURL(record.id))
        return record
    }

    public func touch(_ record: WorkspaceRecord, at date: Date = Date()) throws -> WorkspaceRecord {
        var updated = record
        updated.lastOpenedAt = date
        guard fileManager.fileExists(atPath: workspaceDirectory(record.id).path) else {
            throw WorkspaceStoreError.workspaceNotFound
        }
        try writeJSON(updated, to: recordURL(record.id))
        return updated
    }

    public func importItems(
        _ sources: [URL],
        into record: WorkspaceRecord,
        limits: ImportLimits = ImportLimits()
    ) throws {
        let destinationRoot = filesDirectory(record.id)
        guard isOwned(destinationRoot), fileManager.fileExists(atPath: destinationRoot.path) else {
            throw WorkspaceStoreError.workspaceNotFound
        }
        var fileCount = 0
        var byteCount: Int64 = 0
        for source in sources {
            try validateImport(source, fileCount: &fileCount, byteCount: &byteCount, limits: limits)
            let destination = destinationRoot.appendingPathComponent(source.lastPathComponent)
            guard !fileManager.fileExists(atPath: destination.path) else {
                throw WorkspaceStoreError.destinationExists(source.lastPathComponent)
            }
            try fileManager.copyItem(at: source, to: destination)
        }
    }

    public func exportItem(
        relativePath: String,
        from record: WorkspaceRecord,
        to destinationDirectory: URL
    ) throws -> URL {
        let components = relativePath.split(separator: "/", omittingEmptySubsequences: false)
        guard !relativePath.hasPrefix("/"), !components.isEmpty,
              components.allSatisfy({ $0 != ".." && $0 != "." && !$0.isEmpty }) else {
            throw WorkspaceStoreError.invalidRelativePath
        }
        let sourceRoot = filesDirectory(record.id).standardizedFileURL
        let source = components.reduce(sourceRoot) { $0.appendingPathComponent(String($1)) }.standardizedFileURL
        guard source.path.hasPrefix(sourceRoot.path + "/"), fileManager.fileExists(atPath: source.path) else {
            throw WorkspaceStoreError.invalidRelativePath
        }
        let destination = destinationDirectory.appendingPathComponent(source.lastPathComponent)
        guard !fileManager.fileExists(atPath: destination.path) else {
            throw WorkspaceStoreError.destinationExists(source.lastPathComponent)
        }
        try fileManager.copyItem(at: source, to: destination)
        return destination
    }

    public func removeWorkspace(_ record: WorkspaceRecord) throws {
        let directory = workspaceDirectory(record.id)
        guard isOwned(directory), directory.deletingLastPathComponent().standardizedFileURL == workspacesRoot else {
            throw WorkspaceStoreError.unsafeOwnedPath
        }
        if fileManager.fileExists(atPath: directory.path) {
            try fileManager.removeItem(at: directory)
        }
    }

    public func workspaceDirectory(_ id: UUID) -> URL {
        workspacesRoot.appendingPathComponent(id.uuidString.lowercased(), isDirectory: true)
    }

    public func filesDirectory(_ id: UUID) -> URL {
        workspaceDirectory(id).appendingPathComponent("files", isDirectory: true)
    }

    public func diskURL(_ id: UUID) -> URL {
        workspaceDirectory(id).appendingPathComponent("runtime.img")
    }

    public func provisionDisk(
        for record: WorkspaceRecord,
        from baseDisk: URL,
        expandedSize: UInt64 = WorkspaceStore.defaultExpandedDiskSize
    ) throws -> URL {
        let destination = diskURL(record.id)
        guard isOwned(destination), fileManager.fileExists(atPath: workspaceDirectory(record.id).path) else {
            throw WorkspaceStoreError.workspaceNotFound
        }
        var created = false
        do {
            if !fileManager.fileExists(atPath: destination.path) {
                try fileManager.copyItem(at: baseDisk, to: destination)
                created = true
            }
            let currentSize = try destination.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
            if UInt64(currentSize) < expandedSize {
                let handle = try FileHandle(forWritingTo: destination)
                defer { try? handle.close() }
                try handle.truncate(atOffset: expandedSize)
            }
            try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
            return destination
        } catch {
            if created { try? fileManager.removeItem(at: destination) }
            throw error
        }
    }

    private func recordURL(_ id: UUID) -> URL {
        workspaceDirectory(id).appendingPathComponent("workspace.json")
    }

    private func createPrivateDirectory(_ url: URL) throws {
        try fileManager.createDirectory(
            at: url,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        try fileManager.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
    }

    private func writeJSON<T: Encodable>(_ value: T, to url: URL) throws {
        let data = try encoder.encode(value)
        try data.write(to: url, options: .atomic)
        try fileManager.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
    }

    private func isOwned(_ url: URL) -> Bool {
        let candidate = url.standardizedFileURL.path
        let ownedRoot = workspacesRoot.standardizedFileURL.path
        return candidate.hasPrefix(ownedRoot + "/")
    }

    private func validateImport(
        _ source: URL,
        fileCount: inout Int,
        byteCount: inout Int64,
        limits: ImportLimits
    ) throws {
        let keys: Set<URLResourceKey> = [.isSymbolicLinkKey, .isRegularFileKey, .fileSizeKey]
        let rootValues = try source.resourceValues(forKeys: keys)
        if rootValues.isSymbolicLink == true {
            throw WorkspaceStoreError.symbolicLinkNotAllowed(source.lastPathComponent)
        }
        try account(rootValues, fileCount: &fileCount, byteCount: &byteCount, limits: limits)
        guard let enumerator = fileManager.enumerator(
            at: source,
            includingPropertiesForKeys: Array(keys),
            options: [],
            errorHandler: { _, _ in false }
        ) else { return }
        for case let item as URL in enumerator {
            let values = try item.resourceValues(forKeys: keys)
            if values.isSymbolicLink == true {
                throw WorkspaceStoreError.symbolicLinkNotAllowed(item.lastPathComponent)
            }
            try account(values, fileCount: &fileCount, byteCount: &byteCount, limits: limits)
        }
    }

    private func account(
        _ values: URLResourceValues,
        fileCount: inout Int,
        byteCount: inout Int64,
        limits: ImportLimits
    ) throws {
        guard values.isRegularFile == true else { return }
        fileCount += 1
        byteCount += Int64(values.fileSize ?? 0)
        if fileCount > limits.maximumFiles || byteCount > limits.maximumBytes {
            throw WorkspaceStoreError.importLimitExceeded
        }
    }
}
