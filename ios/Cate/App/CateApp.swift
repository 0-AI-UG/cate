// The iOS shell (architecture 15): native SwiftUI over the client core, which
// runs headless in a hidden web view (CoreHost). Two tabs: the agents of every
// workspace, and the workspaces with their panels. A `cate://pair` link, from
// a QR code scanned with the Camera app, opens the join sheet and joins; a
// notification opens the agent it is about.

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

enum RootTab: Hashable {
    case agents, workspaces
}

struct RootView: View {
    @Environment(CoreHost.self) private var core
    @Environment(Notifier.self) private var notifier
    @State private var tab = RootTab.agents
    @State private var agentsPath = NavigationPath()
    @State private var path = NavigationPath()
    @State private var joining: JoinRequest?

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack(path: $agentsPath) {
                AgentsHomeView(join: { joining = JoinRequest(link: nil) })
                    .agentDestinations()
            }
            .tabItem { Label("Agents", systemImage: "sparkles") }
            .tag(RootTab.agents)

            NavigationStack(path: $path) {
                WorkspacesView(join: { joining = JoinRequest(link: nil) })
                    .navigationDestination(for: String.self) { WorkspaceView(workspaceId: $0) }
                    .agentDestinations()
            }
            .tabItem { Label("Workspaces", systemImage: "desktopcomputer") }
            .tag(RootTab.workspaces)
        }
        .sheet(item: $joining) { request in
            JoinView(link: request.link) { workspaceId in
                joining = nil
                tab = .workspaces
                path = NavigationPath([workspaceId])
            }
        }
        .onChange(of: notifier.route) { _, route in
            guard let route else { return }
            notifier.route = nil
            tab = .agents
            agentsPath = NavigationPath([route])
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
    /// The screens an agent leads to, in either tab.
    func agentDestinations() -> some View {
        navigationDestination(for: PanelRoute.self) { PanelView(route: $0) }
            .navigationDestination(for: AgentRoute.self) { AgentSessionView(route: $0) }
            .navigationDestination(for: ShipRoute.self) { ShipView(route: $0) }
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
