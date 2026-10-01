'use strict';

const { pruneDanglingImages } = require('../lib/image-prune');

describe('pruneDanglingImages never takes containers with it', () => {
    function harness(imagesOutput, failing = new Set()) {
        const calls = [];
        const dockerExecArgs = (args) => {
            calls.push(args);
            if (args[0] === 'images') return imagesOutput;
            if (args[0] === 'rmi' && failing.has(args[1])) throw new Error('image is being used by container');
            return '';
        };
        return { calls, run: () => pruneDanglingImages({ dockerExecArgs, log: () => {} }) };
    }

    test('never passes -f / --force to rmi (podman rmi --force deletes the containers using the image)', () => {
        const h = harness('aaa <none>\nbbb ghcr.io/xcanwin/manyoyo\nccc <none>\n');
        h.run();
        const rmi = h.calls.filter(c => c[0] === 'rmi');
        expect(rmi).toEqual([['rmi', 'aaa'], ['rmi', 'ccc']]);
        rmi.forEach(args => expect(args.some(a => a === '-f' || a === '--force')).toBe(false));
    });

    test('an image still used by a container is simply skipped, the rest is still cleaned', () => {
        const h = harness('aaa <none>\nbbb <none>\nccc <none>\n', new Set(['bbb']));
        expect(() => h.run()).not.toThrow();
        expect(h.calls.filter(c => c[0] === 'rmi').map(c => c[1])).toEqual(['aaa', 'bbb', 'ccc']);
    });

    test('only <none> images are considered, duplicates are removed once, and no container command is ever issued', () => {
        const h = harness('aaa <none>\naaa <none>\nzzz alpine\n');
        h.run();
        expect(h.calls.filter(c => c[0] === 'rmi')).toEqual([['rmi', 'aaa']]);
        const verbs = new Set(h.calls.map(c => c[0]));
        ['rm', 'stop', 'kill', 'container', 'system', 'volume'].forEach(v => expect(verbs.has(v)).toBe(false));
        expect(h.calls[0]).toEqual(['image', 'prune', '-f']);
    });

    test('a failure to list images does not abort', () => {
        const dockerExecArgs = args => { if (args[0] === 'images') throw new Error('boom'); return ''; };
        expect(() => pruneDanglingImages({ dockerExecArgs })).not.toThrow();
    });
});
