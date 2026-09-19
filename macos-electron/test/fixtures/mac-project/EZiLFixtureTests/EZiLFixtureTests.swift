import XCTest
@testable import EZiLFixture

final class EZiLFixtureTests: XCTestCase {
    func testNamedGreetingTrimsWhitespace() {
        XCTAssertEqual(Greeting.message(for: "  EZiL\n"), "Hello, EZiL!")
    }

    func testEmptyGreetingUsesMac() {
        XCTAssertEqual(Greeting.message(for: " \n"), "Hello, Mac!")
    }
}
