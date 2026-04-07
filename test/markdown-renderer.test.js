const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadMarkedBrowserBundle() {
    const markedPackageDir = path.dirname(require.resolve('marked/package.json'));
    const markedScript = fs.readFileSync(path.join(markedPackageDir, 'lib', 'marked.umd.js'), 'utf-8');
    const window = {};
    const context = {
        window,
        globalThis: window,
        self: window,
        global: window,
        console
    };
    vm.runInNewContext(markedScript, context, { filename: 'marked.umd.js' });
    return window.marked;
}

function loadMarkdownRenderer() {
    const scriptPath = path.join(__dirname, '..', 'lib', 'web', 'frontend', 'markdown-renderer.js');
    const script = fs.readFileSync(scriptPath, 'utf-8');
    const listeners = {};
    const appended = [];
    const removed = [];
    const created = [];
    const document = {
        addEventListener: jest.fn((eventName, handler) => {
            listeners[eventName] = handler;
        }),
        createElement: jest.fn(tagName => {
            const element = {
                tagName: String(tagName || '').toUpperCase(),
                style: {},
                click: jest.fn(),
                parentNode: null
            };
            created.push(element);
            return element;
        }),
        body: {
            appendChild: jest.fn(element => {
                element.parentNode = document.body;
                appended.push(element);
            }),
            removeChild: jest.fn(element => {
                element.parentNode = null;
                removed.push(element);
            })
        }
    };
    const window = {
        marked: loadMarkedBrowserBundle(),
        confirm: jest.fn(() => true),
        open: jest.fn()
    };
    const context = {
        window,
        document,
        console
    };

    vm.runInNewContext(script, context, { filename: scriptPath });

    return {
        window,
        document,
        listeners,
        appended,
        removed,
        created
    };
}

describe('markdown renderer', () => {
    test('should render markdown links with safe open attributes under marked v17', () => {
        const runtime = loadMarkdownRenderer();

        const rendered = runtime.window.ManyoyoMarkdown.render('[OpenAI](https://openai.com)');

        expect(rendered).toContain('href="https://openai.com"');
        expect(rendered).toContain('target="_blank"');
        expect(rendered).toContain('rel="noopener noreferrer"');
        expect(rendered).toContain('referrerpolicy="no-referrer"');
        expect(rendered).toContain('data-safe-external-link="true"');
        expect(rendered).toContain('>OpenAI</a>');
    });

    test('should keep bare autolinks visible', () => {
        const runtime = loadMarkdownRenderer();

        const rendered = runtime.window.ManyoyoMarkdown.render('https://example.com');

        expect(rendered).toContain('href="https://example.com"');
        expect(rendered).toContain('>https://example.com</a>');
    });

    test('should expose custom link open handler hook', () => {
        const runtime = loadMarkdownRenderer();
        const clickHandler = runtime.listeners.click;
        const handler = jest.fn();
        const link = {
            href: 'https://openai.com',
            getAttribute: jest.fn(name => {
                if (name === 'data-safe-href') return 'https://openai.com';
                if (name === 'href') return 'https://openai.com';
                return '';
            })
        };
        const event = {
            target: {
                closest: jest.fn(() => link)
            },
            preventDefault: jest.fn(),
            stopPropagation: jest.fn()
        };

        runtime.window.ManyoyoMarkdown.setLinkOpenHandler(handler);
        clickHandler(event);

        expect(handler).toHaveBeenCalledWith('https://openai.com');
        expect(runtime.window.confirm).not.toHaveBeenCalled();
        expect(runtime.document.createElement).not.toHaveBeenCalled();
    });

    test('should not render relative markdown links as clickable anchors', () => {
        const runtime = loadMarkdownRenderer();

        const rendered = runtime.window.ManyoyoMarkdown.render('[内部链接](/api/sessions)');

        expect(rendered).not.toContain('<a ');
        expect(rendered).toContain('内部链接');
    });

    test('should confirm before opening safe external links and use no-referrer anchor', () => {
        const runtime = loadMarkdownRenderer();
        const clickHandler = runtime.listeners.click;
        const link = {
            href: 'https://openai.com',
            getAttribute: jest.fn(name => {
                if (name === 'data-safe-href') return 'https://openai.com';
                if (name === 'href') return 'https://openai.com';
                return '';
            })
        };
        const event = {
            target: {
                closest: jest.fn(() => link)
            },
            preventDefault: jest.fn(),
            stopPropagation: jest.fn()
        };

        clickHandler(event);

        expect(runtime.window.confirm).toHaveBeenCalledWith('即将打开外部链接：\nhttps://openai.com\n\n确认继续打开？');
        expect(event.preventDefault).toHaveBeenCalled();
        expect(event.stopPropagation).toHaveBeenCalled();
        expect(runtime.document.createElement).toHaveBeenCalledWith('a');
        expect(runtime.appended).toHaveLength(1);
        expect(runtime.removed).toHaveLength(1);
        expect(runtime.created[0].href).toBe('https://openai.com');
        expect(runtime.created[0].rel).toBe('noopener noreferrer');
        expect(runtime.created[0].referrerPolicy).toBe('no-referrer');
        expect(runtime.created[0].target).toBe('_blank');
        expect(runtime.created[0].click).toHaveBeenCalled();
    });

    test('should not open link when user cancels confirmation', () => {
        const runtime = loadMarkdownRenderer();
        runtime.window.confirm.mockReturnValue(false);
        const clickHandler = runtime.listeners.click;
        const link = {
            href: 'https://example.com',
            getAttribute: jest.fn(name => {
                if (name === 'data-safe-href') return 'https://example.com';
                if (name === 'href') return 'https://example.com';
                return '';
            })
        };
        const event = {
            target: {
                closest: jest.fn(() => link)
            },
            preventDefault: jest.fn(),
            stopPropagation: jest.fn()
        };

        clickHandler(event);

        expect(runtime.window.confirm).toHaveBeenCalled();
        expect(runtime.document.createElement).not.toHaveBeenCalled();
        expect(runtime.appended).toHaveLength(0);
    });
});
