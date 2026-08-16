const { defineConfig } = require('playwright/test');

module.exports = defineConfig({
    testDir: './test/e2e',
    timeout: 30000,
    outputDir: '/tmp/manyoyo-playwright-results',
    use: {
        baseURL: 'http://127.0.0.1:4318',
        browserName: 'chromium',
        headless: true
    },
    webServer: {
        command: 'node scripts/test-web-server.js',
        url: 'http://127.0.0.1:4318/auth/login',
        reuseExistingServer: false,
        timeout: 30000
    }
});
