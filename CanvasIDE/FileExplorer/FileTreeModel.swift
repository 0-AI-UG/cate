import Foundation
import Combine

// MARK: - FileTreeModel

@MainActor
final class FileTreeModel: ObservableObject {
    @Published var rootNodes: [FileTreeNode] = []
    @Published private(set) var rootPath: String = ""

    private static let defaultExclusions: Set<String> = [
        ".git", "node_modules", ".build", "DerivedData",
        ".DS_Store", "__pycache__", ".swiftpm", "Pods",
        ".Trash", ".cache", ".npm", "dist", "build"
    ]

    private var isGitRepo: Bool = false
    private var gitTrackedFiles: Set<String> = []

    // File system watcher
    private var watchSource: DispatchSourceFileSystemObject?

    // MARK: - Public API

    func setRoot(_ path: String) {
        rootPath = path
        checkGitRepo()
        reload()
        startWatching(path)
    }

    func reload() {
        guard !rootPath.isEmpty else { return }
        rootNodes = buildNodes(at: rootPath, relativeTo: rootPath)
    }

    /// Toggle expansion state of a directory node, reloading its children lazily.
    func toggleExpanded(path: String) {
        rootNodes = toggleInTree(rootNodes, targetPath: path)
    }

    // MARK: - Git

    private func checkGitRepo() {
        let gitDir = (rootPath as NSString).appendingPathComponent(".git")
        isGitRepo = FileManager.default.fileExists(atPath: gitDir)
        if isGitRepo {
            Task { await loadGitTrackedFiles() }
        }
    }

    private func loadGitTrackedFiles() async {
        let path = rootPath
        let files = await Task.detached(priority: .utility) {
            var result: Set<String> = []
            let process = Process()
            process.executableURL = URL(fileURLWithPath: "/usr/bin/git")
            process.arguments = ["-C", path, "ls-files", "--cached", "--others", "--exclude-standard"]
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = Pipe()
            try? process.run()
            process.waitUntilExit()
            let data = pipe.fileHandleForReading.readDataToEndOfFile()
            let output = String(data: data, encoding: .utf8) ?? ""
            for line in output.components(separatedBy: "\n") {
                let trimmed = line.trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty {
                    result.insert(trimmed)
                }
            }
            return result
        }.value

        await MainActor.run {
            self.gitTrackedFiles = files
            self.reload()
        }
    }

    // MARK: - Tree building

    private func buildNodes(at dirPath: String, relativeTo rootBase: String) -> [FileTreeNode] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: dirPath) else { return [] }

        var dirs: [FileTreeNode] = []
        var files: [FileTreeNode] = []

        for entry in entries {
            // Skip hidden files and default exclusions
            if entry.hasPrefix(".") { continue }
            if Self.defaultExclusions.contains(entry) { continue }

            let fullPath = (dirPath as NSString).appendingPathComponent(entry)
            var isDir: ObjCBool = false
            fm.fileExists(atPath: fullPath, isDirectory: &isDir)

            // If git repo, skip files not tracked (but always show directories)
            if isGitRepo && !isDir.boolValue {
                let relPath = fullPath.hasPrefix(rootBase + "/")
                    ? String(fullPath.dropFirst(rootBase.count + 1))
                    : entry
                if !gitTrackedFiles.isEmpty && !gitTrackedFiles.contains(relPath) {
                    continue
                }
            }

            var node = FileTreeNode(name: entry, path: fullPath, isDirectory: isDir.boolValue)
            if isDir.boolValue {
                // Children are loaded lazily on expand; pre-check if non-empty
                node.children = []
                dirs.append(node)
            } else {
                files.append(node)
            }
        }

        // Sort: directories first, each group alphabetically (case-insensitive)
        dirs.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        files.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }

        return dirs + files
    }

    // Recursively walk the tree to toggle expansion and load/unload children
    private func toggleInTree(_ nodes: [FileTreeNode], targetPath: String) -> [FileTreeNode] {
        var result = nodes
        for i in result.indices {
            if result[i].path == targetPath && result[i].isDirectory {
                result[i].isExpanded.toggle()
                if result[i].isExpanded {
                    result[i].children = buildNodes(at: result[i].path, relativeTo: rootPath)
                } else {
                    result[i].children = []
                }
                return result
            }
            if !result[i].children.isEmpty {
                result[i].children = toggleInTree(result[i].children, targetPath: targetPath)
            }
        }
        return result
    }

    // MARK: - File watching

    private func startWatching(_ path: String) {
        stopWatching()
        let fd = open(path, O_EVTONLY)
        guard fd >= 0 else { return }
        let source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: fd,
            eventMask: [.write, .rename, .delete],
            queue: .main
        )
        source.setEventHandler { [weak self] in
            self?.reload()
        }
        source.setCancelHandler {
            close(fd)
        }
        source.resume()
        watchSource = source
    }

    private func stopWatching() {
        watchSource?.cancel()
        watchSource = nil
    }

    deinit {
        // DispatchSource cancel must happen; we call it synchronously from deinit
        watchSource?.cancel()
    }
}
