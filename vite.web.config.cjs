const path = require('path');
const { defineConfig } = require('vite');
const react = require('@vitejs/plugin-react');

module.exports = defineConfig({
    root: path.resolve(__dirname, 'lib/web/frontend'),
    cacheDir: path.resolve(__dirname, 'node_modules/.vite-manyoyo-web'),
    base: '/app/',
    plugins: [react()],
    build: {
        outDir: path.resolve(__dirname, 'lib/web/frontend/dist'),
        emptyOutDir: true,
        manifest: true,
        rollupOptions: {
            input: path.resolve(__dirname, 'lib/web/frontend/index.html'),
            output: {
                manualChunks(id) {
                    if (!id.includes('node_modules')) return undefined;
                    if (id.includes('@xterm')) return 'xterm';
                    if (id.includes('@codemirror/lang-')) {
                        const match = id.match(/@codemirror\/lang-([^/]+)/);
                        return match ? `codemirror-${match[1]}` : 'codemirror-languages';
                    }
                    if (id.includes('@codemirror') || id.includes('/node_modules/codemirror/')) return 'codemirror-core';
                    return undefined;
                }
            }
        }
    }
});
