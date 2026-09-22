import SwiftUI

struct Greeting {
    static func message(for name: String) -> String {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        return "Hello, \(trimmed.isEmpty ? "Mac" : trimmed)!"
    }
}

@main
struct EZiLFixtureApp: App {
    var body: some Scene {
        WindowGroup {
            VStack(spacing: 16) {
                Text("EZiL macOS fixture").font(.title)
                Text(Greeting.message(for: "Mac"))
                    .accessibilityIdentifier("fixture-greeting")
            }
            .padding(32)
            .frame(minWidth: 360, minHeight: 180)
        }
    }
}
