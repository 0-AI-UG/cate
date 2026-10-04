// Shared by the app and its notification extension: the key this device's
// pushes are sealed with, and opening one. The runtime seals each push with
// ChaCha20-Poly1305 under this key (src/runtime/push/contract/seal.ts), so
// Cate Connect and Apple only ever carry ciphertext.

import CryptoKit
import Foundation
import Security

/// What a push carries (`PushMessage`): one notification event.
struct PushMessage: Codable {
    let runtimeId: String
    let workspace: String
    let kind: String
    let panelId: String?
    let title: String
    let body: String
}

/// How this app shows a notification event: its category's actions.
enum NotificationCategory {
    /// An agent waits for the person's next prompt: Reply.
    static let input = "agent.input"
    /// Anything else: opening it shows the agent.
    static let notice = "cate.notice"

    static func of(kind: String, panelId: String?) -> String {
        kind == "agent.needsInput" && panelId != nil ? input : notice
    }
}

enum PushKey {
    private static let service = "com.0ai.cate.ios.push"
    private static let account = "key"

    /// The Keychain group the app and the extension share, from Info.plist
    /// (`$(AppIdentifierPrefix)com.0ai.cate.ios.shared`); nil in an unsigned build.
    private static var group: String? {
        guard let value = Bundle.main.object(forInfoDictionaryKey: "CateSharedKeychainGroup") as? String,
              !value.isEmpty, !value.hasPrefix("com.") else { return nil }
        return value
    }

    private static func query(group: String?) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let group { query[kSecAttrAccessGroup as String] = group }
        return query
    }

    /// The key, or nil before the app made one.
    static func load() -> SymmetricKey? {
        for candidate in [group, nil] {
            var query = query(group: candidate)
            query[kSecReturnData as String] = true
            query[kSecMatchLimit as String] = kSecMatchLimitOne
            var item: CFTypeRef?
            if SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data, data.count == 32 {
                return SymmetricKey(data: data)
            }
            if group == nil { break }
        }
        return nil
    }

    /// The key, made and stored on first use. Readable after first unlock,
    /// since pushes arrive while the phone is locked.
    static func loadOrCreate() -> SymmetricKey {
        if let key = load() { return key }
        let key = SymmetricKey(size: .bits256)
        let data = key.withUnsafeBytes { Data($0) }
        for candidate in [group, nil] {
            var add = query(group: candidate)
            add[kSecValueData as String] = data
            add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            if SecItemAdd(add as CFDictionary, nil) == errSecSuccess { break }
            if group == nil { break }
        }
        return key
    }

    /// Opens a sealed push (base64 of nonce, ciphertext and tag).
    static func open(_ sealed: String, with key: SymmetricKey) -> PushMessage? {
        guard let combined = Data(base64Encoded: sealed),
              let box = try? ChaChaPoly.SealedBox(combined: combined),
              let plain = try? ChaChaPoly.open(box, using: key) else { return nil }
        return try? JSONDecoder().decode(PushMessage.self, from: plain)
    }
}
