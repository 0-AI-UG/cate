// Notifications: what agents ask for, shown by this app while it runs (the
// core hands it each event) and pushed by the runtime through Cate Connect
// while it does not (opened by the notification extension). Both carry the
// same identifier per panel, so a push replaces a banner already shown.
// Reply opens the app and sends the reply to the agent from there.

import SwiftUI
import UIKit
import UserNotifications

/// An agent's session, as notifications and the agents home open it.
struct AgentRoute: Hashable {
    let workspaceId: String
    let panelId: String
}

@MainActor
@Observable
final class Notifier: NSObject, UNUserNotificationCenterDelegate {
    private enum Action {
        static let reply = "reply"
    }

    /// The session a notification asked to open; the root view navigates.
    var route: AgentRoute?
    /// An action from a notification that did not go through.
    var failure: String?

    /// The agent session on screen: its notifications stay quiet.
    @ObservationIgnored var viewing: AgentRoute?
    @ObservationIgnored private weak var core: CoreHost?
    @ObservationIgnored private var token: String?
    /// Banners this app showed, by identifier, so a push about the same
    /// thing does not show twice while the app runs.
    @ObservationIgnored private var shown: [String: Date] = [:]

    func attach(_ core: CoreHost) {
        self.core = core
        core.notifications = { [weak self] in self?.show($0) }
        core.withdrawNotification = { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: [$0]) }
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        center.setNotificationCategories([
            UNNotificationCategory(identifier: NotificationCategory.input, actions: [
                UNTextInputNotificationAction(identifier: Action.reply, title: "Reply", options: [.authenticationRequired, .foreground],
                                              textInputButtonTitle: "Send", textInputPlaceholder: "Tell the agent…"),
            ], intentIdentifiers: []),
            UNNotificationCategory(identifier: NotificationCategory.notice, actions: [], intentIdentifiers: []),
        ])
        // Already allowed: get the push token now. Asking waits until there
        // is a workspace whose agents could notify (`askIfNeeded`).
        Task {
            if await center.notificationSettings().authorizationStatus == .authorized {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Asks once to notify, when a paired workspace makes it worth it.
    func askIfNeeded() {
        Task {
            let center = UNUserNotificationCenter.current()
            guard await center.notificationSettings().authorizationStatus == .notDetermined else { return }
            if (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) == true {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    // MARK: Push registration

    func registered(deviceToken: Data) {
        token = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { await sendDevice() }
    }

    /// Gives the core where this phone's pushes go (its APNs target, which
    /// only Cate Connect reads) and the key they are sealed with; it
    /// registers them with every workspace it connects to.
    private func sendDevice() async {
        guard let core, let token else { return }
        let key = PushKey.loadOrCreate().withUnsafeBytes { Data($0) }.base64EncodedString()
        #if DEBUG
        let environment = "sandbox"
        #else
        let environment = "production"
        #endif
        await core.call("push.device", ["target": "apns:\(environment):\(token)", "key": key])
    }

    // MARK: Banners while the app runs

    private func show(_ notification: CoreNotification) {
        if let panelId = notification.panelId, viewing == AgentRoute(workspaceId: notification.workspaceId, panelId: panelId) { return }
        let content = UNMutableNotificationContent()
        content.title = notification.title
        content.subtitle = core?.workspace(notification.workspaceId)?.name ?? ""
        content.body = notification.body
        content.sound = .default
        content.categoryIdentifier = NotificationCategory.of(kind: notification.kind, panelId: notification.panelId)
        content.threadIdentifier = notification.workspaceId
        var info: [String: Any] = ["workspaceId": notification.workspaceId, "kind": notification.kind]
        if let panelId = notification.panelId { info["panelId"] = panelId }
        content.userInfo = info
        shown[notification.id] = Date()
        shown = shown.filter { $0.value > Date().addingTimeInterval(-120) }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notification.id, content: content, trigger: nil))
    }

    // MARK: UNUserNotificationCenterDelegate

    /// What a notification names, taken out of its user info.
    private struct Subject: Sendable {
        let workspaceId: String?
        let runtimeId: String?
        let panelId: String?

        init(_ info: [AnyHashable: Any]) {
            workspaceId = info["workspaceId"] as? String
            runtimeId = info["runtimeId"] as? String
            panelId = info["panelId"] as? String
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let identifier = notification.request.identifier
        let pushed = notification.request.trigger is UNPushNotificationTrigger
        let subject = Subject(notification.request.content.userInfo)
        return await MainActor.run {
            if pushed, shown[identifier].map({ $0 > Date().addingTimeInterval(-120) }) == true { return [] }
            if let route = route(subject), route == viewing { return [] }
            return [.banner, .list, .sound]
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let subject = Subject(response.notification.request.content.userInfo)
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await handle(subject, action: action, text: text)
    }

    private func handle(_ subject: Subject, action: String, text: String?) async {
        guard let core, let target = await resolve(subject, core: core) else { return }
        route = target
        guard action == Action.reply, let text, !text.isEmpty else { return }
        guard await core.connected(target.workspaceId) else {
            failure = "Could not reach the workspace to send the reply."
            return
        }
        let result = await core.action("agents.send", ["workspaceId": target.workspaceId, "panelId": target.panelId, "prompt": text])
        if !result.ok { failure = result.message ?? "The agent did not take the reply." }
    }

    /// The session a notification is about: a banner names the workspace, a
    /// push its runtime (the core's state may still be loading).
    private func resolve(_ subject: Subject, core: CoreHost) async -> AgentRoute? {
        guard let panelId = subject.panelId else { return nil }
        if let workspaceId = subject.workspaceId { return AgentRoute(workspaceId: workspaceId, panelId: panelId) }
        guard let runtimeId = subject.runtimeId else { return nil }
        for _ in 0..<50 {
            if let workspace = core.workspace(runtimeId: runtimeId) { return AgentRoute(workspaceId: workspace.id, panelId: panelId) }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return nil
    }

    private func route(_ subject: Subject) -> AgentRoute? {
        guard let panelId = subject.panelId else { return nil }
        if let workspaceId = subject.workspaceId { return AgentRoute(workspaceId: workspaceId, panelId: panelId) }
        if let runtimeId = subject.runtimeId, let workspace = core?.workspace(runtimeId: runtimeId) {
            return AgentRoute(workspaceId: workspace.id, panelId: panelId)
        }
        return nil
    }
}

/// Owns the core and the notifier from launch, so a notification that
/// launched the app is handled.
final class AppDelegate: NSObject, UIApplicationDelegate {
    @MainActor let core = CoreHost()
    @MainActor let notifier = Notifier()

    @MainActor
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        notifier.attach(core)
        return true
    }

    @MainActor
    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        notifier.registered(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        print("push registration failed: \(error)")
    }
}
