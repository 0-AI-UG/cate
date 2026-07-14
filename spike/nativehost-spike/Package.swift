// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "nativehost-spike",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "nativehost-spike",
            path: "Sources/nativehost-spike"
        )
    ]
)
