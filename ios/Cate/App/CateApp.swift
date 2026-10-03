// The iOS shell (architecture 15): native SwiftUI over the client core, which
// runs headless in a hidden web view (CoreHost). A `cate://pair` link, from a
// QR code scanned with the Camera app, opens the join sheet and joins.

import SwiftUI

@main
struct CateApp: App {
    @State private var core = CoreHost()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(core)
                // The core's web view must be in the window to keep running.
                .background(HiddenCoreView(webView: core.webView))
        }
    }
}

struct RootView: View {
    @Environment(CoreHost.self) private var core
    @State private var path = NavigationPath()
    @State private var joining: JoinRequest?

    var body: some View {
        NavigationStack(path: $path) {
            WorkspacesView(join: { joining = JoinRequest(link: nil) })
                .navigationDestination(for: String.self) { WorkspaceView(workspaceId: $0) }
                .navigationDestination(for: PanelRoute.self) { PanelView(route: $0) }
        }
        .sheet(item: $joining) { request in
            JoinView(link: request.link) { workspaceId in
                joining = nil
                path = NavigationPath([workspaceId])
            }
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
