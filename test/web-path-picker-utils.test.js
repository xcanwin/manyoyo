const pathPickerUtils = require('../lib/web/frontend/path-picker-utils');

describe('web path picker utils', () => {
    test('should keep container base path stable across repeated selections', () => {
        const baseHostPath = '/repo';
        const baseContainerPath = '/workspace';

        const firstPick = pathPickerUtils.applyContainerPathSelection(
            baseHostPath,
            baseContainerPath,
            '/workspace/src',
            '/repo/src'
        );
        expect(firstPick).toBe('/workspace/src');

        const secondPick = pathPickerUtils.applyContainerPathSelection(
            baseHostPath,
            baseContainerPath,
            firstPick,
            '/repo/docs'
        );
        expect(secondPick).toBe('/workspace/docs');
    });

    test('should fallback to current container path when base path is empty', () => {
        expect(
            pathPickerUtils.applyContainerPathSelection(
                '/repo',
                '',
                '/workspace/custom',
                '/repo'
            )
        ).toBe('/workspace/custom');
    });
});
