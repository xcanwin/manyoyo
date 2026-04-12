package io.github.xcanwin.manyoyo.mobile;

import android.content.res.Configuration;
import android.webkit.WebView;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import java.util.Locale;

public class MainActivity extends BridgeActivity {

    private static final String HOST_SAFE_AREA_STYLE = """
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
""";

    private Insets lastSafeAreaInsets = Insets.NONE;

    @Override
    protected void load() {
        super.load();
        installHostSafeAreaBridge();
    }

    @Override
    public void onResume() {
        super.onResume();
        syncHostSafeAreaInsets();
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        super.onConfigurationChanged(newConfig);
        syncHostSafeAreaInsets();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            syncHostSafeAreaInsets();
        }
    }

    private void installHostSafeAreaBridge() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        getBridge().addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageLoaded(WebView webView) {
                    injectHostSafeAreaScript(webView, lastSafeAreaInsets);
                }

                @Override
                public void onPageCommitVisible(WebView webView, String url) {
                    injectHostSafeAreaScript(webView, lastSafeAreaInsets);
                }
            }
        );

        getBridge().getWebView().post(this::syncHostSafeAreaInsets);
    }

    private void syncHostSafeAreaInsets() {
        if (getBridge() == null || getBridge().getWebView() == null) {
            return;
        }

        final WebView webView = getBridge().getWebView();
        final WindowInsetsCompat rootInsets = ViewCompat.getRootWindowInsets(webView);
        if (rootInsets == null) {
            injectHostSafeAreaScript(webView, lastSafeAreaInsets);
            return;
        }

        final Insets systemInsets = rootInsets.getInsets(
            WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
        );
        lastSafeAreaInsets = rootInsets.isVisible(WindowInsetsCompat.Type.ime())
            ? Insets.of(systemInsets.left, systemInsets.top, systemInsets.right, 0)
            : systemInsets;
        injectHostSafeAreaScript(webView, lastSafeAreaInsets);
    }

    private void injectHostSafeAreaScript(WebView webView, Insets insets) {
        final float density = getResources().getDisplayMetrics().density;
        final double top = insets.top / density;
        final double right = insets.right / density;
        final double bottom = insets.bottom / density;
        final double left = insets.left / density;

        final String script = String.format(
            Locale.US,
            """
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
              style.textContent = `%s`;
            })();
            """,
            top,
            right,
            bottom,
            left,
            HOST_SAFE_AREA_STYLE
        );

        webView.post(() -> webView.evaluateJavascript(script, null));
    }
}
