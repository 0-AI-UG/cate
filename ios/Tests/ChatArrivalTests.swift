// Run: swiftc ios/Cate/App/ChatArrival.swift ios/Tests/ChatArrivalTests.swift -o /tmp/cate-chat-tests && /tmp/cate-chat-tests
import Foundation

@main
enum ChatArrivalTests {
    static func main() {
        let followedAt = ChatArrival.date("2026-11-02T12:00:00.000Z")!
        // History arriving after an empty loaded snapshot stays unanimated.
        precondition(!ChatArrival.isLive(createdAt: "2026-11-02T11:59:00Z", followedAt: followedAt, hasHistory: true))
        precondition(ChatArrival.isLive(createdAt: "2026-11-02T12:00:01.123Z", followedAt: followedAt, hasHistory: false))
        precondition(!ChatArrival.isLive(createdAt: nil, followedAt: followedAt, hasHistory: false))
        precondition(ChatArrival.isLive(createdAt: nil, followedAt: followedAt, hasHistory: true))
        precondition(!ChatArrival.isLive(createdAt: "invalid", followedAt: followedAt, hasHistory: false))
        print("Chat arrival tests passed")
    }
}
