(function () {
    function getNativeBridge() {
        if (window.ManyoyoNativeBridge && typeof window.ManyoyoNativeBridge === 'object') {
            return window.ManyoyoNativeBridge;
        }
        return null;
    }

    function callNative(methodName, args) {
        const bridge = getNativeBridge();
        if (!bridge || typeof bridge[methodName] !== 'function') {
            return undefined;
        }
        try {
            return bridge[methodName].apply(bridge, Array.isArray(args) ? args : []);
        } catch (e) {
            return undefined;
        }
    }

    function getLocalStorage() {
        try {
            return window.localStorage || null;
        } catch (e) {
            return null;
        }
    }

    function openExternalFallback(url) {
        const text = String(url || '').trim();
        if (!text) {
            return false;
        }

        if (typeof document !== 'undefined' && document && typeof document.createElement === 'function') {
            const anchor = document.createElement('a');
            anchor.href = text;
            anchor.target = '_blank';
            anchor.rel = 'noopener noreferrer';
            anchor.referrerPolicy = 'no-referrer';
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            try {
                if (typeof anchor.click === 'function') {
                    anchor.click();
                    return true;
                }
            } finally {
                if (anchor.parentNode && typeof anchor.parentNode.removeChild === 'function') {
                    anchor.parentNode.removeChild(anchor);
                }
            }
        }

        if (typeof window.open === 'function') {
            const opened = window.open(text, '_blank', 'noopener,noreferrer');
            if (opened) {
                opened.opener = null;
            }
            return Boolean(opened);
        }

        return false;
    }

    const platform = {
        kind: getNativeBridge() ? 'native-shell' : 'browser',
        getStorageItem(key) {
            const customValue = callNative('getStorageItem', [String(key || '')]);
            if (typeof customValue === 'string') {
                return customValue;
            }
            const storage = getLocalStorage();
            if (!storage) {
                return null;
            }
            return storage.getItem(String(key || ''));
        },
        setStorageItem(key, value) {
            const handled = callNative('setStorageItem', [String(key || ''), String(value == null ? '' : value)]);
            if (handled !== undefined) {
                return;
            }
            const storage = getLocalStorage();
            if (!storage) {
                return;
            }
            storage.setItem(String(key || ''), String(value == null ? '' : value));
        },
        removeStorageItem(key) {
            const handled = callNative('removeStorageItem', [String(key || '')]);
            if (handled !== undefined) {
                return;
            }
            const storage = getLocalStorage();
            if (!storage) {
                return;
            }
            storage.removeItem(String(key || ''));
        },
        alert(message) {
            const text = String(message == null ? '' : message);
            const handled = callNative('alert', [text]);
            if (handled !== undefined) {
                return handled;
            }
            if (typeof window.alert === 'function') {
                return window.alert(text);
            }
            return undefined;
        },
        confirm(message) {
            const text = String(message == null ? '' : message);
            const handled = callNative('confirm', [text]);
            if (typeof handled === 'boolean') {
                return handled;
            }
            if (typeof window.confirm === 'function') {
                return window.confirm(text);
            }
            return true;
        },
        prompt(message, defaultValue) {
            const text = String(message == null ? '' : message);
            const fallback = defaultValue == null ? '' : String(defaultValue);
            const handled = callNative('prompt', [text, fallback]);
            if (handled === null || typeof handled === 'string') {
                return handled;
            }
            if (typeof window.prompt === 'function') {
                return window.prompt(text, fallback);
            }
            return null;
        },
        navigate(url) {
            const text = String(url || '').trim() || '/';
            const handled = callNative('navigate', [text]);
            if (handled !== undefined) {
                return handled;
            }
            window.location.href = text;
            return true;
        },
        openExternal(url) {
            const text = String(url || '').trim();
            const handled = callNative('openExternal', [text]);
            if (typeof handled === 'boolean') {
                return handled;
            }
            return openExternalFallback(text);
        },
        fetch(input, init) {
            return window.fetch(input, init);
        },
        createWebSocket(url) {
            return new window.WebSocket(String(url || ''));
        },
        createTextDecoder(label) {
            return new window.TextDecoder(label);
        },
        createUrl(pathname, base) {
            return new window.URL(pathname, base);
        }
    };

    window.ManyoyoPlatform = platform;
})();
