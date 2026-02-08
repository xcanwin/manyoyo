(function () {
    const form = document.getElementById('loginForm');
    const userNode = document.getElementById('username');
    const passNode = document.getElementById('password');
    const submitBtn = document.getElementById('loginBtn');
    const errorNode = document.getElementById('error');

    userNode.focus();

    form.addEventListener('submit', async function (event) {
        event.preventDefault();
        if (submitBtn.disabled) return;
        errorNode.textContent = '';
        const previousText = submitBtn.textContent;
        submitBtn.disabled = true;
        submitBtn.textContent = '登录中...';
        try {
            const response = await fetch('/auth/login', {
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
            window.location.href = '/';
        } catch (e) {
            errorNode.textContent = e.message || '登录失败';
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = previousText;
        }
    });
})();
