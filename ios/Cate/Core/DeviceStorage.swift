// Device state behind the bridge: the core's device documents as JSON files
// in Application Support (`DeviceStore`), and secrets in the Keychain.

import Foundation
import Security

/// `<Application Support>/Cate/device/<name>.json`, written atomically.
struct DeviceFiles {
    private let dir: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("Cate/device", isDirectory: true)

    private func file(_ name: String) throws -> URL {
        guard !name.isEmpty, name.allSatisfy({ $0.isLetter || $0.isNumber || $0 == "-" }) else {
            throw ShellBridge.BridgeError(description: "bad device document name \(name)")
        }
        return dir.appendingPathComponent("\(name).json")
    }

    func get(_ name: String) throws -> String? {
        let url = try file(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return try String(contentsOf: url, encoding: .utf8)
    }

    func set(_ name: String, json: String) throws {
        let url = try file(name)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        try Data(json.utf8).write(to: url, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
}

/// Generic passwords of this app, kept on this device only.
struct Keychain {
    let service: String

    private func query(_ name: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: name]
    }

    func get(_ name: String) throws -> String? {
        var q = query(name)
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        let status = SecItemCopyMatching(q as CFDictionary, &item)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = item as? Data else { throw KeychainError(status: status) }
        return String(decoding: data, as: UTF8.self)
    }

    func set(_ name: String, value: String) throws {
        let data = Data(value.utf8)
        let status = SecItemUpdate(query(name) as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecSuccess { return }
        guard status == errSecItemNotFound else { throw KeychainError(status: status) }
        var add = query(name)
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let added = SecItemAdd(add as CFDictionary, nil)
        guard added == errSecSuccess else { throw KeychainError(status: added) }
    }
}

struct KeychainError: Error, CustomStringConvertible {
    let status: OSStatus
    var description: String { "keychain error \(status)" }
}
