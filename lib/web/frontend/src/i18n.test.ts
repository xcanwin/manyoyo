import { getLocale, translate } from './i18n';
import { describe, expect, test } from 'vitest';

describe('workbench locale', () => {
    test('uses Chinese by default, supports English, and falls back safely', () => {
        expect(getLocale('en')).toBe('en');
        expect(getLocale('invalid')).toBe('zh');
        expect(translate('en', 'newSession')).toBe('New');
        expect(translate('zh', 'newSession')).toBe('新建');
    });

    test('provides English labels for workspace states and advanced fields', () => {
        expect(translate('en', 'terminalConnecting')).toBe('Connecting terminal…');
        expect(translate('en', 'fileConflict')).toBe('The file was changed externally.');
        expect(translate('en', 'containerPath')).toBe('Container path');
        expect(translate('en', 'messages')).toBe('messages');
    });
});
