// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "EZiLOSCore",
    platforms: [.macOS(.v14)],
    products: [.library(name: "EZiLOSCore", targets: ["EZiLOSCore"])],
    targets: [
        .target(name: "EZiLOSCore"),
        .testTarget(name: "EZiLOSCoreTests", dependencies: ["EZiLOSCore"]),
    ]
)
