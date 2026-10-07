// The iOS shell (architecture 15): native SwiftUI over the client core, which
// runs headless in a hidden web view (CoreHost). One stack: the workspaces,
// then a workspace with its agents and panels. A `cate://pair` link, from a
// QR code scanned with the Camera app, opens the join sheet and joins; a
// notification opens its workspace and the agent it is about.

import SwiftUI

@main
struct CateApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var delegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(delegate.core)
                .environment(delegate.notifier)
                // The core's web view must be in the window to keep running.
                .background(HiddenCoreView(webView: delegate.core.webView))
        }
    }
}

struct RootView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    @State private var path = NavigationPath()
    @State private var joining: JoinRequest?

    var body: some View {
        NavigationStack(path: $path) {
            WorkspacesView(join: { joining = JoinRequest(link: nil) })
                .navigationDestination(for: String.self) { WorkspaceView(workspaceId: $0) }
                .agentDestinations()
        }
        .sheet(item: $joining) { request in
            JoinView(link: request.link) { workspaceId in
                joining = nil
                path = NavigationPath([workspaceId])
            }
        }
        .onChange(of: notifier.route) { _, route in
            guard let route else { return }
            notifier.route = nil
            var next = NavigationPath()
            next.append(route.workspaceId)
            next.append(route)
            path = next
        }
        .alert("Not sent", isPresented: Binding(get: { notifier.failure != nil }, set: { if !$0 { notifier.failure = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(notifier.failure ?? "")
        }
        .onOpenURL { url in
            guard QRScanner.isPairingLink(url.absoluteString) else { return }
            joining = JoinRequest(link: url.absoluteString)
        }
        .overlay {
            if let failure = core.failure {
                ContentUnavailableView("Cate could not start", systemImage: "exclamationmark.triangle", description: Text(failure))
                    .background(.background)
            }
        }
    }
}

extension View {
    /// The screens a workspace leads to: its panels, its agents' chats and a
    /// new agent chat.
    func agentDestinations() -> some View {
        navigationDestination(for: PanelRoute.self) { PanelView(route: $0) }
            .navigationDestination(for: AgentRoute.self) { AgentChatView(workspaceId: $0.workspaceId, panelId: $0.panelId) }
            .navigationDestination(for: NewAgentRoute.self) { AgentChatView(workspaceId: $0.workspaceId, panelId: nil, canvasPanelId: $0.canvasPanelId) }
    }
}

struct JoinRequest: Identifiable {
    let id = UUID()
    let link: String?
}

/// Keeps the core's web view in the window, invisible and out of the way.
struct HiddenCoreView: UIViewRepresentable {
    let webView: UIView

    func makeUIView(context: Context) -> UIView {
        let container = UIView(frame: .zero)
        container.isUserInteractionEnabled = false
        container.alpha = 0.01
        webView.frame = CGRect(x: 0, y: 0, width: 1, height: 1)
        container.addSubview(webView)
        return container
    }

    func updateUIView(_ view: UIView, context: Context) {}
}
