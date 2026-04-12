import UIKit
import WebKit
import Capacitor

class ManyoyoBridgeViewController: CAPBridgeViewController {

    private static let hostSafeAreaStyle = """
@media (max-width: 980px) {
  :root.manyoyo-host-safe-area .header {
    padding-top: calc(6px + var(--manyoyo-host-safe-top) + 12px) !important;
  }

  :root.manyoyo-host-safe-area .sidebar {
    padding-top: calc(16px + var(--manyoyo-host-safe-top) + 12px) !important;
    padding-right: calc(16px + var(--manyoyo-host-safe-right)) !important;
    padding-bottom: calc(16px + var(--manyoyo-host-safe-bottom)) !important;
    padding-left: calc(16px + var(--manyoyo-host-safe-left)) !important;
  }
}

@media (max-width: 640px) {
  :root.manyoyo-host-safe-area .header {
    padding: calc(10px + var(--manyoyo-host-safe-top) + 12px) 12px 16px !important;
  }
}
"""

    private var progressObservation: NSKeyValueObservation?

    override func capacitorDidLoad() {
        super.capacitorDidLoad()

        progressObservation = webView?.observe(\.estimatedProgress, options: [.new]) { [weak self] _, _ in
            self?.syncHostSafeAreaStyle()
        }

        syncHostSafeAreaStyle()
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        syncHostSafeAreaStyle()
    }

    override func viewSafeAreaInsetsDidChange() {
        super.viewSafeAreaInsetsDidChange()
        syncHostSafeAreaStyle()
    }

    deinit {
        progressObservation?.invalidate()
    }

    private func syncHostSafeAreaStyle() {
        guard let webView else {
            return
        }

        let insets = view.safeAreaInsets
        let script = String(
            format: """
            (function() {
              const root = document.documentElement;
              if (!root) {
                return;
              }
              root.classList.add('manyoyo-host-safe-area');
              root.style.setProperty('--manyoyo-host-safe-top', '%.2fpx');
              root.style.setProperty('--manyoyo-host-safe-right', '%.2fpx');
              root.style.setProperty('--manyoyo-host-safe-bottom', '%.2fpx');
              root.style.setProperty('--manyoyo-host-safe-left', '%.2fpx');
              const styleId = 'manyoyo-host-safe-area-style';
              let style = document.getElementById(styleId);
              if (!style) {
                style = document.createElement('style');
                style.id = styleId;
                (document.head || document.documentElement).appendChild(style);
              }
              style.textContent = `%@`;
            })();
            """,
            locale: Locale(identifier: "en_US_POSIX"),
            insets.top,
            insets.right,
            insets.bottom,
            insets.left,
            Self.hostSafeAreaStyle
        )

        webView.evaluateJavaScript(script, completionHandler: nil)
    }
}
