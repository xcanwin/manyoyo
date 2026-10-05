'use strict';
(function () {
    try {
        const blocked = ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCIceCandidate', 'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCDataChannel'];
        for (const name of blocked) {
            Object.defineProperty(globalThis, name, { configurable: true, writable: true, value: undefined });
        }
        if (navigator.mediaDevices) {
            Object.defineProperty(navigator.mediaDevices, 'getUserMedia', {
                configurable: true,
                writable: true,
                value: async () => { throw new DOMException('WebRTC is disabled', 'NotAllowedError'); }
            });
        }
    } catch (_) {}
})();
