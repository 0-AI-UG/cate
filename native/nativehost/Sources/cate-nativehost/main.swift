//
//  main.swift — cate-nativehost entry point.
//
//  Production capture sidecar for Cate's "native apps on canvas" feature
//  (macOS). Launches a target app onto a headless virtual display and
//  streams JPEG-encoded ScreenCaptureKit frames over a UNIX-domain socket.
//  See PROTOCOL.md for the wire format.
//

import Foundation

func printUsage() {
    let usage = """
    cate-nativehost — capture sidecar for native apps on the Cate canvas

    USAGE:
      cate-nativehost serve --bundle <bundleID> --socket <path> [--width N] [--height N] [--fps N]

    OPTIONS:
      --bundle <bundleID>   Required. Bundle identifier of the app to launch and capture.
      --socket <path>       Required. Filesystem path for the UNIX-domain socket this
                             process creates and listens on (server role).
      --width <N>           Virtual display width in pixels. Default 1440.
      --height <N>          Virtual display height in pixels. Default 900.
      --fps <N>             Capture frame rate. Default 12.

    See PROTOCOL.md at the package root for the socket wire format.
    """
    FileHandle.standardError.write((usage + "\n").data(using: .utf8)!)
}

let arguments = CommandLine.arguments
let command = arguments.count > 1 ? arguments[1] : "help"

switch command {
case "serve":
    do {
        let options = try ServeOptionsParser.parse(Array(arguments.dropFirst(2)))
        let runner = ServeRunner(options: options)
        runner.run()
    } catch {
        FileHandle.standardError.write("ERROR: \(error)\n\n".data(using: .utf8)!)
        printUsage()
        exit(64)
    }

case "help", "-h", "--help":
    printUsage()

default:
    FileHandle.standardError.write("Unknown subcommand: \(command)\n\n".data(using: .utf8)!)
    printUsage()
    exit(64)
}
