import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

/// The whole interface is the same page as the desktop app, shown full screen in a web view.
struct WebContainer: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> WebViewController { WebViewController() }
    func updateUIViewController(_ controller: WebViewController, context: Context) {}
}

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate {
    private(set) var webView: WKWebView!

    override func loadView() {
        let config = WKWebViewConfiguration()
        let scripts = WKUserContentController()
        // the TAPE_IOS flag and no page zoom, added before the page's own script runs
        if let url = Bundle.module.url(forResource: "ios-shim", withExtension: "js"),
           let source = try? String(contentsOf: url, encoding: .utf8) {
            scripts.addUserScript(WKUserScript(source: source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        config.userContentController = scripts
        config.websiteDataStore = .default()

        let web = WKWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = UIColor(red: 0.047, green: 0.063, blue: 0.086, alpha: 1)
        web.scrollView.bounces = false
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.allowsBackForwardNavigationGestures = false
        if #available(iOS 16.4, *) { web.isInspectable = true } // Safari's Web Inspector can attach while developing
        web.navigationDelegate = self
        web.uiDelegate = self
        webView = web
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        AppModel.shared.controller = self
        AppModel.shared.load()
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    func showFailure(_ message: String) {
        let html = "<body style='background:#0c1016;color:#d6dce6;font:16px -apple-system;padding:40px'>\(message)</body>"
        webView.loadHTMLString(html, baseURL: nil)
    }

    // iOS ends the page's process under memory pressure; bring it back rather than showing a blank screen
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        AppModel.shared.load()
    }

    // the page's own links never leave the app
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction) async -> WKNavigationActionPolicy {
        if let url = navigationAction.request.url, url.host != "127.0.0.1", url.scheme == "http" || url.scheme == "https" {
            await UIApplication.shared.open(url)
            return .cancel
        }
        return .allow
    }

    // links meant for a new window (the chart credit's link to tradingview.com) open in Safari
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url, url.scheme == "https" || url.scheme == "http" {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async {
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume() })
            present(alert, animated: true)
        }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo) async -> Bool {
        await withCheckedContinuation { (done: CheckedContinuation<Bool, Never>) in
            let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
            alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in done.resume(returning: false) })
            alert.addAction(UIAlertAction(title: "OK", style: .default) { _ in done.resume(returning: true) })
            present(alert, animated: true)
        }
    }
}

/// The system document picker: CSV, DBN and .zst files from Files, iCloud Drive or other apps.
/// Picked files arrive as copies in the app's own temporary folder.
@MainActor
final class FilePicker: NSObject, UIDocumentPickerDelegate {
    private var waiting: CheckedContinuation<[URL]?, Never>?

    func pick(from controller: UIViewController) async -> [URL]? {
        if let earlier = waiting { earlier.resume(returning: nil); waiting = nil }
        return await withCheckedContinuation { continuation in
            waiting = continuation
            let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
            picker.allowsMultipleSelection = true
            picker.delegate = self
            controller.present(picker, animated: true)
        }
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        waiting?.resume(returning: urls)
        waiting = nil
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        waiting?.resume(returning: nil)
        waiting = nil
    }
}
