import XCTest
@testable import EZiLOSCore

final class WorkspaceStoreTests: XCTestCase {
    private var temporaryRoot: URL!
    private var store: WorkspaceStore!

    override func setUpWithError() throws {
        temporaryRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("ezil-core-tests-\(UUID().uuidString)", isDirectory: true)
        store = WorkspaceStore(root: temporaryRoot)
        try store.prepare()
    }

    override func tearDownWithError() throws {
        if let temporaryRoot { try? FileManager.default.removeItem(at: temporaryRoot) }
    }

    func testGuestProfileIsRandomAndPersistent() throws {
        let first = try store.loadOrCreateGuestProfile()
        let second = try store.loadOrCreateGuestProfile()
        XCTAssertEqual(first, second)

        let otherRoot = FileManager.default.temporaryDirectory
            .appendingPathComponent("ezil-core-tests-other-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: otherRoot) }
        XCTAssertNotEqual(first.id, try WorkspaceStore(root: otherRoot).loadOrCreateGuestProfile().id)
    }

    func testCreatesPrivatePersistentWorkspace() throws {
        let record = try store.createWorkspace(named: "Website")
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.filesDirectory(record.id).path))
        XCTAssertEqual(record.editorPassword.count, 64)
        XCTAssertEqual(try store.listWorkspaces(), [record])
        let permissions = try FileManager.default.attributesOfItem(atPath: store.workspaceDirectory(record.id).path)[.posixPermissions] as? NSNumber
        XCTAssertEqual((permissions?.intValue ?? -1) & 0o777, 0o700)
    }

    func testRejectsBlankAndOverlongWorkspaceNames() throws {
        XCTAssertThrowsError(try store.createWorkspace(named: "  "))
        XCTAssertThrowsError(try store.createWorkspace(named: String(repeating: "a", count: 81)))
    }

    func testImportCopiesInsteadOfMountingSource() throws {
        let record = try store.createWorkspace()
        let source = temporaryRoot.appendingPathComponent("outside.txt")
        try Data("first".utf8).write(to: source)
        try store.importItems([source], into: record)
        try Data("second".utf8).write(to: source)
        let imported = store.filesDirectory(record.id).appendingPathComponent("outside.txt")
        XCTAssertEqual(String(decoding: try Data(contentsOf: imported), as: UTF8.self), "first")
    }

    func testImportRejectsSymlinkAndLimits() throws {
        let record = try store.createWorkspace()
        let source = temporaryRoot.appendingPathComponent("source.txt")
        let link = temporaryRoot.appendingPathComponent("link.txt")
        try Data("12345".utf8).write(to: source)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: source)
        XCTAssertThrowsError(try store.importItems([link], into: record))
        XCTAssertThrowsError(try store.importItems([source], into: record, limits: .init(maximumFiles: 1, maximumBytes: 2)))
    }

    func testExportDoesNotDeleteOrLinkOriginal() throws {
        let record = try store.createWorkspace()
        let source = store.filesDirectory(record.id).appendingPathComponent("app.js")
        try Data("console.log(1)".utf8).write(to: source)
        let destination = temporaryRoot.appendingPathComponent("export", isDirectory: true)
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let exported = try store.exportItem(relativePath: "app.js", from: record, to: destination)
        try Data("changed".utf8).write(to: source)
        XCTAssertEqual(String(decoding: try Data(contentsOf: exported), as: UTF8.self), "console.log(1)")
    }

    func testExportRejectsTraversal() throws {
        let record = try store.createWorkspace()
        for path in ["../secret", "/tmp/secret", "a/../../secret", "./secret", "a//b"] {
            XCTAssertThrowsError(try store.exportItem(relativePath: path, from: record, to: temporaryRoot))
        }
    }

    func testRemoveDeletesOnlyOwnedWorkspace() throws {
        let first = try store.createWorkspace(named: "First")
        let second = try store.createWorkspace(named: "Second")
        let outside = temporaryRoot.appendingPathComponent("keep.txt")
        try Data("keep".utf8).write(to: outside)
        try store.removeWorkspace(first)
        XCTAssertFalse(FileManager.default.fileExists(atPath: store.workspaceDirectory(first.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: store.workspaceDirectory(second.id).path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path))
    }

    func testProvisionDiskCopiesAndSparseExpandsWithoutShrinking() throws {
        let record = try store.createWorkspace()
        let base = temporaryRoot.appendingPathComponent("base.img")
        try Data("seed".utf8).write(to: base)
        let expandedSize: UInt64 = 32 * 1_024 * 1_024

        let disk = try store.provisionDisk(for: record, from: base, expandedSize: expandedSize)
        let attributes = try FileManager.default.attributesOfItem(atPath: disk.path)
        XCTAssertEqual((attributes[.size] as? NSNumber)?.uint64Value, expandedSize)
        let permissions = attributes[.posixPermissions] as? NSNumber
        XCTAssertEqual((permissions?.intValue ?? -1) & 0o777, 0o600)
        let handle = try FileHandle(forReadingFrom: disk)
        defer { try? handle.close() }
        XCTAssertEqual(try handle.read(upToCount: 4), Data("seed".utf8))

        _ = try store.provisionDisk(for: record, from: base, expandedSize: 1_024)
        XCTAssertEqual(
            (try FileManager.default.attributesOfItem(atPath: disk.path)[.size] as? NSNumber)?.uint64Value,
            expandedSize
        )
    }
}
