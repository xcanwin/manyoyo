'use strict';

const { validateResolvedRunSpec } = require('../lib/core/run-spec');

describe('ResolvedRunSpec contract', () => {
    const validSpec = {
        configVersion: 1,
        image: { name: 'localhost/xcanwin/manyoyo', version: '1.9.1-common' },
        container: {
            name: 'demo',
            mode: 'common',
            modeArgs: [],
            hostPath: '/host',
            containerPath: '/workspace',
            envFile: [],
            env: {},
            volumes: [],
            ports: [],
            extraArgs: [],
            imageBuildArgs: []
        },
        process: { prefix: '', shell: '', suffix: '', tty: true },
        provenance: {}
    };

    test('accepts the resolved container schema including common/dind/sock modes', () => {
        expect(validateResolvedRunSpec(validSpec)).toBe(validSpec);
        expect(validateResolvedRunSpec({
            ...validSpec,
            container: { ...validSpec.container, mode: 'sock', modeArgs: ['--privileged'] }
        })).toEqual(expect.objectContaining({ container: expect.objectContaining({ mode: 'sock' }) }));
    });

    test('rejects invalid versions, modes and non-array container fields', () => {
        expect(() => validateResolvedRunSpec({ ...validSpec, configVersion: 2 })).toThrow('configVersion');
        expect(() => validateResolvedRunSpec({
            ...validSpec,
            image: { ...validSpec.image, version: 'latest' }
        })).toThrow('image.version');
        expect(() => validateResolvedRunSpec({
            ...validSpec,
            container: { ...validSpec.container, mode: 'unsafe' }
        })).toThrow('container.mode');
        expect(() => validateResolvedRunSpec({
            ...validSpec,
            container: { ...validSpec.container, volumes: '/host:/workspace' }
        })).toThrow('container.volumes');
    });
});
