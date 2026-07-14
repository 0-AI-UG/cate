// swift-tools-version:5.10
import PackageDescription

let package = Package(
    name: "nativehost",
    platforms: [
        .macOS(.v14)
    ],
    targets: [
        .executableTarget(
            name: "cate-nativehost",
            path: "Sources/cate-nativehost"
        )
    ]
)
