// Native password UI and the main-frame DOM adapter. The runtime owns all
// credential storage and matching; the page never gets a core API bridge.
import SwiftUI
import WebKit

private final class PasswordMessageHandler: NSObject, WKScriptMessageHandler {
    weak var owner: BrowserPasswords?
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        MainActor.assumeIsolated { owner?.receive(message) }
    }
}

@MainActor
@Observable
final class BrowserPasswords {
    struct Suggestion: Decodable, Identifiable {
        let id: String
        let username: String
        let origin: String
    }
    struct Credential: Decodable {
        let username: String
        let password: String
    }
    struct Submission {
        let input: [String: String]
        let disposition: String
    }
    private(set) var suggestions: [Suggestion] = []
    private(set) var submission: Submission?
    var error: String?
    private weak var webView: WKWebView?
    private weak var session: PanelSession<BrowserSnapshot>?
    private let tabId: String
    private var active = true
    private var document = UUID()
    private var target: String?
    private var pendingInput: [String: String]?
    private let handler = PasswordMessageHandler()
    private static let world = WKContentWorld.world(name: "catePasswords")

    init(tabId: String, session: PanelSession<BrowserSnapshot>) {
        self.tabId = tabId
        self.session = session
        handler.owner = self
    }

    func configure(_ config: WKWebViewConfiguration) {
        config.userContentController.add(handler, contentWorld: Self.world, name: "passwords")
        config.userContentController.addUserScript(WKUserScript(source: Self.script, injectionTime: .atDocumentStart, forMainFrameOnly: true, in: Self.world))
    }

    func attach(_ webView: WKWebView) { self.webView = webView }

    func setActive(_ active: Bool) {
        self.active = active
        if !active { navigated() }
    }

    func navigated() {
        document = UUID()
        target = nil
        suggestions = []
        // A captured submission can still be saved after its login redirects.
    }

    private static func origin(_ url: URL?) -> String? {
        guard let url, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme), let host = url.host else { return nil }
        let port = url.port.flatMap { (scheme == "https" && $0 == 443) || (scheme == "http" && $0 == 80) ? nil : ":\($0)" } ?? ""
        return "\(scheme)://\(host)\(port)"
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard active, message.webView === webView, message.frameInfo.isMainFrame,
              let origin = Self.origin(message.frameInfo.request.url),
              origin == Self.origin(webView?.url),
              let body = message.body as? [String: String] else { return }
        if body["kind"] == "focus" {
            target = body["target"]
            suggestions = []
            guard let target, let session else { return }
            let generation = document
            Task {
                do {
                    let found = try await session.call("browser.passwordSuggestions", ["tabId": tabId, "url": origin], as: [Suggestion].self)
                    guard active, generation == document, self.target == target, Self.origin(webView?.url) == origin else { return }
                    suggestions = found
                } catch { self.error = "Could not load saved passwords. \(error.localizedDescription)" }
            }
        } else if body["kind"] == "submit", let password = body["password"], !password.isEmpty {
            let input = ["origin": origin, "username": body["username"] ?? "", "password": password,
                         "usernameElement": body["usernameElement"] ?? "", "passwordElement": body["passwordElement"] ?? ""]
            guard pendingInput == nil, submission == nil, let session else { return }
            pendingInput = input
            Task {
                defer { pendingInput = nil }
                do {
                    let disposition = try await session.call("browser.passwordSaveDisposition", ["tabId": tabId, "input": input], as: String.self)
                    if disposition != "unchanged" { submission = Submission(input: input, disposition: disposition) }
                } catch { self.error = "Could not check the submitted password. \(error.localizedDescription)" }
            }
        }
    }

    func fill(_ suggestion: Suggestion) async {
        guard active, let target, let origin = Self.origin(webView?.url), let session, let webView else { return }
        let generation = document
        do {
            let credential = try await session.call("browser.passwordForFill", ["tabId": tabId, "url": origin, "id": suggestion.id], as: Credential?.self)
            guard active, generation == document, self.target == target, Self.origin(webView.url) == origin else { return }
            guard let credential else { error = "This saved password is no longer available."; return }
            let filled = try await webView.callAsyncJavaScript("return globalThis.cateFill(target, origin, username, password)",
                arguments: ["target": target, "origin": origin, "username": credential.username, "password": credential.password],
                in: nil, contentWorld: Self.world)
            if filled as? Bool != true { error = "The login form changed. Select the field again." }
            suggestions = []
        } catch { self.error = "Could not fill the saved password. \(error.localizedDescription)" }
    }

    func dismissSave() { submission = nil }

    func save() async {
        guard let submission, let session else { return }
        self.submission = nil
        do {
            let _: AnyJSON = try await session.call("browser.savePassword", ["tabId": tabId, "input": submission.input], as: AnyJSON.self)
        } catch {
            self.submission = submission
            self.error = "Could not save the password. \(error.localizedDescription)"
        }
    }

    // Runs in an isolated world. DOM targets stay private to this document;
    // only the selected form receives a credential, after an origin recheck.
    static let script = #"""
    (() => {
      let marked = null, target = null, previousUsername = '';
      const send = body => window.webkit.messageHandlers.passwords.postMessage(body);
      const username = el => ['text', 'email', 'tel'].includes(el.type) &&
        (/username|email/.test(el.autocomplete) || el.type === 'email' || /user|login|email|account|identifier/i.test(el.name + ' ' + el.id));
      const fields = scope => Array.from(scope instanceof HTMLFormElement ? scope.elements : scope.querySelectorAll('input'))
        .filter(el => el instanceof HTMLInputElement && !el.disabled && !el.readOnly);
      document.addEventListener('focusin', event => {
        const el = event.target;
        marked = el instanceof HTMLInputElement && !el.disabled && !el.readOnly && (el.type === 'password' || username(el)) ? el : null;
        target = marked ? Array.from(crypto.getRandomValues(new Uint32Array(4)), n => n.toString(16)).join('-') : null;
        send({kind: 'focus', ...(target ? {target} : {})});
      }, true);
      const capture = scope => {
        const inputs = fields(scope);
        const user = inputs.find(el => username(el) && el.value) || inputs.find(el => el.type === 'text' && el.value);
        if (user) previousUsername = user.value;
        const passwords = inputs.filter(el => el.type === 'password' && el.value);
        const pass = passwords.find(el => el.autocomplete === 'new-password') || passwords.find(el => el.autocomplete === 'current-password') || passwords[0];
        if (pass) send({kind: 'submit', username: user?.value || previousUsername, password: pass.value,
          usernameElement: user ? user.name || user.id : '', passwordElement: pass.name || pass.id});
      };
      document.addEventListener('submit', event => { if (event.target instanceof HTMLFormElement) capture(event.target); }, true);
      document.addEventListener('click', event => {
        const button = event.target instanceof Element && event.target.closest('button,input[type=submit],input[type=button],[role=button]');
        if (!button || button.hasAttribute('disabled')) return;
        const submits = (button instanceof HTMLButtonElement || button instanceof HTMLInputElement) && button.type === 'submit';
        if (submits || /sign\s*in|log\s*in|sign\s*up|register|continue|next|anmelden|weiter/i.test(button.textContent || button.value || button.getAttribute('aria-label') || ''))
          capture(button.form || button.closest('form') || document.body);
      }, true);
      document.addEventListener('keydown', event => {
        if (event.key === 'Enter' && event.target instanceof HTMLInputElement) capture(event.target.form || document.body);
      }, true);
      globalThis.cateFill = (id, origin, user, password) => {
        if (location.origin !== origin || target !== id || !marked?.isConnected || marked.disabled || marked.readOnly) return false;
        const inputs = fields(marked.form || document.body);
        const pass = marked.type === 'password' ? marked : inputs.find(el => el.type === 'password' && el.autocomplete !== 'new-password');
        const name = username(marked) ? marked : inputs.find(username);
        const set = (el, value) => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, value);
          el.dispatchEvent(new Event('input', {bubbles: true}));
          el.dispatchEvent(new Event('change', {bubbles: true}));
        };
        if (!name && !pass) return false;
        if (name) set(name, user);
        if (pass && pass.isConnected && location.origin === origin) set(pass, password);
        return true;
      };
    })();
    """#
}

struct BrowserPasswordControls: View {
    @Bindable var passwords: BrowserPasswords
    var body: some View {
        VStack(spacing: 8) {
            if !passwords.suggestions.isEmpty {
                Menu {
                    ForEach(passwords.suggestions) { suggestion in
                        Button("\(suggestion.username.isEmpty ? "Saved password" : suggestion.username) — \(suggestion.origin)") {
                            Task { await passwords.fill(suggestion) }
                        }
                    }
                } label: { Label("Use saved password", systemImage: "key.fill").padding(12) }
                .glassEffect(.regular.interactive(), in: Capsule())
            }
            if let submission = passwords.submission {
                VStack(spacing: 8) {
                    Text("\(submission.disposition == "update" ? "Update" : "Save") password for \(submission.input["origin"] ?? "")?")
                        .font(.footnote)
                    if let username = submission.input["username"], !username.isEmpty { Text(username).font(.footnote).lineLimit(1) }
                    HStack {
                        Button("Not now") { passwords.dismissSave() }
                        Spacer()
                        Button(submission.disposition == "update" ? "Update" : "Save") { Task { await passwords.save() } }
                    }
                }
                .padding(14)
                .glassEffect(.regular.interactive(), in: RoundedRectangle(cornerRadius: 18))
            }
        }
        .alert("Passwords", isPresented: Binding(get: { passwords.error != nil }, set: { if !$0 { passwords.error = nil } })) {
            Button("OK") { passwords.error = nil }
        } message: { Text(passwords.error ?? "") }
    }
}
