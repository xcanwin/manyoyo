import { describe, expect, test } from 'vitest';
import { renderSafeMarkdown } from './markdown';

describe('safe Markdown rendering', () => {
    test('keeps Markdown links while dropping raw HTML and unsafe protocols', () => {
        const html = renderSafeMarkdown('[文档](https://example.com) <img src=x onerror=alert(1)> [坏链接](javascript:alert(1))');

        expect(html).toContain('href="https://example.com"');
        expect(html).toContain('rel="noopener noreferrer"');
        expect(html).not.toContain('<img');
        expect(html).not.toContain('javascript:');
    });
});
