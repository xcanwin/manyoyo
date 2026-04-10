(function () {
    const LOGIN_HINT_STORAGE_KEY = 'manyoyo.web.loginHint.v1';
    const platform = window.ManyoyoPlatform || {
        fetch: function (input, init) {
            return window.fetch(input, init);
        },
        getStorageItem: function (key) {
            return window.localStorage ? window.localStorage.getItem(key) : null;
        },
        setStorageItem: function (key, value) {
            if (window.localStorage) {
                window.localStorage.setItem(key, value);
            }
        },
        navigate: function (url) {
            window.location.href = url;
        }
    };

    function preventAccidentalZoom() {
        let lastTouchEnd = 0;

        document.addEventListener('dblclick', function (event) {
            event.preventDefault();
        }, { passive: false });

        document.addEventListener('touchstart', function (event) {
            if (event.touches && event.touches.length > 1) {
                event.preventDefault();
            }
        }, { passive: false });

        document.addEventListener('touchmove', function (event) {
            if (event.touches && event.touches.length > 1) {
                event.preventDefault();
            }
        }, { passive: false });

        document.addEventListener('touchend', function (event) {
            const now = Date.now();
            if (now - lastTouchEnd <= 320) {
                event.preventDefault();
            }
            lastTouchEnd = now;
        }, { passive: false });

        ['gesturestart', 'gesturechange', 'gestureend'].forEach(function (eventName) {
            document.addEventListener(eventName, function (event) {
                event.preventDefault();
            }, { passive: false });
        });
    }

    preventAccidentalZoom();

    const form = document.getElementById('loginForm');
    const userNode = document.getElementById('username');
    const passNode = document.getElementById('password');
    const submitBtn = document.getElementById('loginBtn');
    const errorNode = document.getElementById('error');
    const badgeNode = document.getElementById('loginBadge');
    const titleNode = document.getElementById('loginTitle');
    const descNode = document.getElementById('loginDesc');

    function getRuntimeBrand() {
        if (window.ManyoyoPlatform && window.ManyoyoPlatform.kind === 'native-shell') {
            return {
                badge: 'MANYOYO Desktop',
                title: 'Desktop 登录',
                description: '登录后可恢复桌面工作台与最近会话状态。',
                pageTitle: 'MANYOYO Desktop Login'
            };
        }
        if (window.ManyoyoPlatform && window.ManyoyoPlatform.kind === 'capacitor') {
            return {
                badge: 'MANYOYO Mobile',
                title: 'Mobile 登录',
                description: '登录后可恢复移动端工作台与最近会话状态。',
                pageTitle: 'MANYOYO Mobile Login'
            };
        }
        return {
            badge: 'MANYOYO',
            title: 'Web 登录',
            description: '登录后可访问容器会话与对话管理。',
            pageTitle: 'MANYOYO Web Login'
        };
    }

    function applyRuntimeBrand() {
        const brand = getRuntimeBrand();
        document.title = brand.pageTitle;
        if (badgeNode) {
            badgeNode.textContent = brand.badge;
        }
        if (titleNode) {
            titleNode.textContent = brand.title;
        }
        if (descNode) {
            descNode.textContent = brand.description;
        }
    }

    function loadLoginHint() {
        try {
            const raw = platform.getStorageItem(LOGIN_HINT_STORAGE_KEY);
            if (!raw) {
                return;
            }
            const parsed = JSON.parse(raw);
            const username = parsed && typeof parsed.username === 'string' ? parsed.username.trim() : '';
            if (username) {
                userNode.value = username;
            }
        } catch (e) {
            // 忽略本地状态异常，避免打断登录
        }
    }

    function persistLoginHint() {
        try {
            platform.setStorageItem(LOGIN_HINT_STORAGE_KEY, JSON.stringify({
                username: (userNode.value || '').trim()
            }));
        } catch (e) {
            // 忽略浏览器存储异常，避免影响登录流程
        }
    }

    applyRuntimeBrand();
    loadLoginHint();
    if (userNode.value) {
        passNode.focus();
    } else {
        userNode.focus();
    }

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (submitBtn.disabled) return;
        errorNode.textContent = '';
        const previousText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = '登录中...';
        try {
            const response = await platform.fetch('/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    username: (userNode.value || '').trim(),
                    password: passNode.value || ''
                })
            });
            const payload = await response.json().catch(function () { return {}; });
            if (!response.ok) {
                throw new Error(payload.error || '登录失败');
            }
            persistLoginHint();
            platform.navigate('/');
        } catch (e) {
            errorNode.textContent = e.message || '登录失败';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = previousText;
        }
    });
})();
