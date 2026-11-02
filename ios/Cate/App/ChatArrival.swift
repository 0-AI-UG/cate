import Foundation

/// CLI timestamps may carry fractional seconds or whole seconds.
enum ChatArrival {
    static func isLive(createdAt: String?, followedAt: Date, hasHistory: Bool) -> Bool {
        createdAt.flatMap(date).map { $0 >= followedAt } ?? hasHistory
    }

    static func date(_ value: String) -> Date? {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = format.date(from: value) { return date }
        format.formatOptions = [.withInternetDateTime]
        return format.date(from: value)
    }
}
