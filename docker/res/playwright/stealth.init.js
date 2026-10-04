'use strict';
(function () {
    try {
        const toolbar = 87;
        const patch = (name, fallback, getter) => {
            const original = Object.getOwnPropertyDescriptor(window, name);
            if (!original || !original.get) return;
            const real = original.get;
            Object.defineProperty(window, name, { ...original, get: getter(function () { const value = real.call(this); return value === 0 ? fallback() : value; }) });
        };
        patch('outerWidth', () => window.innerWidth, fn => Object.getOwnPropertyDescriptor({ get outerWidth() { return fn.call(this); } }, 'outerWidth').get);
        patch('outerHeight', () => window.innerHeight + toolbar, fn => Object.getOwnPropertyDescriptor({ get outerHeight() { return fn.call(this); } }, 'outerHeight').get);
    } catch (_) {}
})();
