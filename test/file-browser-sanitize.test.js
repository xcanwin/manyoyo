const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFileBrowser() {
    const scriptPath = path.join(__dirname, '..', 'lib', 'web', 'frontend', 'file-browser.js');
    const script = fs.readFileSync(scriptPath, 'utf-8');
    const window = {};
    const context = { window, globalThis: window, self: window, console };
    vm.runInNewContext(script, context, { filename: scriptPath });
    return window.ManyoyoFileBrowser;
}

describe('ManyoyoFileBrowser.sanitizeDisplayText', () => {
    const { sanitizeDisplayText } = loadFileBrowser();

    test('leaves normal filenames untouched', () => {
        expect(sanitizeDisplayText('normal-file.txt')).toBe('normal-file.txt');
    });

    test('neutralizes RTLO (U+202E) so the visual order cannot be spoofed', () => {
        const rtloName = 'cod' + String.fromCodePoint(0x202e) + 'exe.txt';
        expect(sanitizeDisplayText(rtloName)).toBe('cod\\u202Eexe.txt');
    });

    test('neutralizes zero-width space (U+200B)', () => {
        const name = 'zero' + String.fromCodePoint(0x200b) + 'width.txt';
        expect(sanitizeDisplayText(name)).toBe('zero\\u200Bwidth.txt');
    });

    test('neutralizes BOM / zero-width no-break space (U+FEFF)', () => {
        const name = 'bom' + String.fromCodePoint(0xfeff) + 'file.txt';
        expect(sanitizeDisplayText(name)).toBe('bom\\uFEFFfile.txt');
    });

    test('neutralizes Arabic letter mark (U+061C)', () => {
        const name = 'arabic' + String.fromCodePoint(0x061c) + 'mark.txt';
        expect(sanitizeDisplayText(name)).toBe('arabic\\u061Cmark.txt');
    });

    test('neutralizes directional isolates (U+2066-U+2069)', () => {
        const name = 'a' + String.fromCodePoint(0x2066) + 'b' + String.fromCodePoint(0x2069) + 'c.txt';
        expect(sanitizeDisplayText(name)).toBe('a\\u2066b\\u2069c.txt');
    });

    test('handles null/undefined/empty input safely', () => {
        expect(sanitizeDisplayText(null)).toBe('');
        expect(sanitizeDisplayText(undefined)).toBe('');
        expect(sanitizeDisplayText('')).toBe('');
    });
});
