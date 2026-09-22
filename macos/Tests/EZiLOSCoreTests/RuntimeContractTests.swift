import XCTest
@testable import EZiLOSCore

final class RuntimeContractTests: XCTestCase {
    func testManifestAcceptsPinnedArmRuntime() throws {
        let digest = String(repeating: "a", count: 64)
        let manifest = RuntimeManifest(
            formatVersion: 1,
            architecture: "arm64",
            minimumMacOS: "14.0",
            kernelSHA256: digest,
            initrdSHA256: digest,
            diskSHA256: digest,
            codeServerVersion: "4.104.2"
        )
        XCTAssertNoThrow(try manifest.validate())
    }

    func testManifestRejectsWrongArchitectureFormatAndDigests() throws {
        let digest = String(repeating: "a", count: 64)
        XCTAssertThrowsError(try RuntimeManifest(formatVersion: 2, architecture: "arm64", minimumMacOS: "14", kernelSHA256: digest, initrdSHA256: digest, diskSHA256: digest, codeServerVersion: "x").validate())
        XCTAssertThrowsError(try RuntimeManifest(formatVersion: 1, architecture: "amd64", minimumMacOS: "14", kernelSHA256: digest, initrdSHA256: digest, diskSHA256: digest, codeServerVersion: "x").validate())
        XCTAssertThrowsError(try RuntimeManifest(formatVersion: 1, architecture: "arm64", minimumMacOS: "14", kernelSHA256: "no", initrdSHA256: digest, diskSHA256: digest, codeServerVersion: "x").validate())
    }

    func testReadyMessageAcceptsOnlyPrivateIPv4AndValidPort() throws {
        XCTAssertEqual(try RuntimeReady(line: "EZIL_READY ip=192.168.64.2 editor=8443"), RuntimeReady(address: "192.168.64.2", editorPort: 8443))
        for line in [
            "ready ip=192.168.64.2 editor=8443",
            "EZIL_READY ip=8.8.8.8 editor=8443",
            "EZIL_READY ip=192.168.64.2 editor=0",
            "EZIL_READY ip=not-an-ip editor=8443",
        ] {
            XCTAssertThrowsError(try RuntimeReady(line: line))
        }
    }

    func testStateMachineRefusesOutOfOrderEvents() throws {
        var machine = RuntimeStateMachine()
        XCTAssertFalse(machine.apply(.prepared))
        XCTAssertTrue(machine.apply(.prepare))
        XCTAssertTrue(machine.apply(.prepared))
        let ready = try RuntimeReady(line: "EZIL_READY ip=10.0.0.2 editor=8443")
        XCTAssertTrue(machine.apply(.ready(ready)))
        XCTAssertEqual(machine.phase, .running(ready))
        XCTAssertTrue(machine.apply(.stop))
        XCTAssertTrue(machine.apply(.stopped))
        XCTAssertEqual(machine.phase, .idle)
    }
}
