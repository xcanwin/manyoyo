(function () {
    function isNearBottom(scrollTop, scrollHeight, clientHeight, thresholdPx) {
        const threshold = Number.isFinite(thresholdPx) ? thresholdPx : 40;
        const distance = scrollHeight - (scrollTop + clientHeight);
        return distance <= threshold;
    }

    window.ManyoyoChatBehavior = {
        isNearBottom
    };
}());
