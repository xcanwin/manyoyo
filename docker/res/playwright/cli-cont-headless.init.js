'use strict';

(function () {
    const platformValue = 'MacIntel';
    try {
        const navProto = Object.getPrototypeOf(navigator);
        Object.defineProperty(navProto, 'platform', {
            configurable: true,
            get: () => platformValue
        });
    } catch (_) {}
})();
