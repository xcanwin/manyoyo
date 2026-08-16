const fs = require('fs');
const path = require('path');
const packageJson = require('../package.json');

describe('React Web build foundation', () => {
    test('exposes a typed Vite build for the web workbench', () => {
        expect(packageJson.scripts['build:web']).toBe('vite build --config vite.web.config.cjs');
        expect(packageJson.scripts.prepack).toBe('npm run build:web');
        expect(fs.existsSync(path.join(__dirname, '../vite.web.config.cjs'))).toBe(true);
        expect(fs.existsSync(path.join(__dirname, '../tsconfig.web.json'))).toBe(true);
        expect(fs.existsSync(path.join(__dirname, '../lib/web/frontend/src/main.tsx'))).toBe(true);
    });

    test('runs typecheck, frontend tests and build in the release workflow', () => {
        const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/npm-publish.yml'), 'utf8');
        expect(workflow).toContain('npm run typecheck:web');
        expect(workflow).toContain('npm run test:web');
        expect(workflow).toContain('npm run build:web');
        expect(workflow).toContain('npm run test:e2e');
        expect(packageJson.scripts['test:e2e']).toBe('playwright test --config playwright.config.cjs');
    });

    test('keeps the React workbench search, theme and reduced-motion affordances', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/src/App.tsx'), 'utf8');
        const styles = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/src/styles.css'), 'utf8');

        expect(appSource).toContain("'manyoyo-theme'");
        expect(appSource).toContain('filterSessions(sessions, sessionQuery)');
        expect(appSource).toContain("event.key.toLowerCase() === 'k'");
        expect(appSource).toContain("event.key.toLowerCase() === 'n'");
        expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
        expect(styles).toContain(':focus-visible');
    });

    test('keeps the create dialog focused and moves container-path overrides into advanced options', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/src/App.tsx'), 'utf8');
        const advancedIndex = appSource.indexOf('<details><summary>{t(\'advancedOptions\')}</summary>');
        const containerPathIndex = appSource.indexOf("t('containerPath')");

        expect(advancedIndex).toBeGreaterThan(-1);
        expect(containerPathIndex).toBeGreaterThan(advancedIndex);
    });

    test('persists a resizable desktop workspace width without changing mobile layout', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/src/App.tsx'), 'utf8');
        const styles = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/src/styles.css'), 'utf8');

        expect(appSource).toContain("'manyoyo-workspace-width'");
        expect(appSource).toContain('aria-label={t(\'workspaceWidth\')}');
        expect(styles).toContain('@media (max-width: 860px)');
    });

    test('exports the existing redacted session audit from the workbench', () => {
        const appSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/src/App.tsx'), 'utf8');
        const apiSource = fs.readFileSync(path.join(__dirname, '../lib/web/frontend/src/api.ts'), 'utf8');

        expect(apiSource).toContain('getSessionAudit: (name: string)');
        expect(apiSource).toContain('/audit`');
        expect(appSource).toContain('await webApi.getSessionAudit(activeSession)');
        expect(appSource).toContain('application/json');
        expect(appSource).toContain("t('exportAudit')");
    });
});
