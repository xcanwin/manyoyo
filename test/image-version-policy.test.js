'use strict';

const { resolveUpdateImageVersion } = require('../lib/image-version-policy');

describe('resolveUpdateImageVersion', () => {
    test('no configured value follows the new default', () => {
        expect(resolveUpdateImageVersion({ configured: '', previousDefault: '2.0.0-common', nextDefault: '2.0.1-common' }))
            .toEqual({ imageVersion: '2.0.1-common', advance: false, pinned: false });
    });

    test('a value equal to the old default is an auto-written pin: advance it', () => {
        expect(resolveUpdateImageVersion({ configured: '2.0.0-common', previousDefault: '2.0.0-common', nextDefault: '2.0.1-common' }))
            .toEqual({ imageVersion: '2.0.1-common', advance: true, pinned: false });
    });

    test('a deliberately different value is respected and reported as pinned', () => {
        expect(resolveUpdateImageVersion({ configured: '1.9.2-common', previousDefault: '2.0.0-common', nextDefault: '2.0.1-common' }))
            .toEqual({ imageVersion: '1.9.2-common', advance: false, pinned: true });
    });

    test('an unchanged default needs no advance', () => {
        expect(resolveUpdateImageVersion({ configured: '2.0.0-common', previousDefault: '2.0.0-common', nextDefault: '2.0.0-common' }))
            .toEqual({ imageVersion: '2.0.0-common', advance: false, pinned: false });
    });
});
