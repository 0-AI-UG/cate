// The notification service extension: opens each push sealed for this
// device and shows what it says. Cate Connect only adds a generic alert,
// which stays if the push cannot be opened.

import UserNotifications

final class NotificationService: UNNotificationServiceExtension {
    override func didReceive(_ request: UNNotificationRequest, withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        if let sealed = content.userInfo["s"] as? String, let key = PushKey.load(), let message = PushKey.open(sealed, with: key) {
            content.title = message.title
            content.subtitle = message.workspace
            content.body = message.body
            content.categoryIdentifier = NotificationCategory.of(kind: message.kind, panelId: message.panelId)
            content.threadIdentifier = message.runtimeId
            var info = content.userInfo
            info.removeValue(forKey: "s")
            info["runtimeId"] = message.runtimeId
            info["kind"] = message.kind
            if let panelId = message.panelId { info["panelId"] = panelId }
            content.userInfo = info
        }
        contentHandler(content)
    }
}
