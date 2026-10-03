'use strict';

const { parsePodmanMajor, defaultNetworkComponent, installCommand, checkRootlessNetwork } = require('../lib/rootless-network');

describe('rootless network component', () => {
    test('picks slirp4netns for podman 4.x and pasta from 5.x', () => {
        expect(defaultNetworkComponent(parsePodmanMajor('podman version 4.9.3'))).toBe('slirp4netns');
        expect(defaultNetworkComponent(parsePodmanMajor('podman version 5.2.1'))).toBe('pasta');
        expect(defaultNetworkComponent(parsePodmanMajor('???'))).toBe('slirp4netns');
    });

    test('builds the install command per distro family', () => {
        expect(installCommand('slirp4netns', { osRelease: 'ID=ubuntu\n' })).toBe('sudo apt-get install -y slirp4netns');
        expect(installCommand('pasta', { osRelease: 'ID=linuxmint\nID_LIKE="ubuntu debian"\n' })).toBe('sudo apt-get install -y passt');
        expect(installCommand('pasta', { osRelease: 'ID=fedora\n', hasDnf: true })).toBe('sudo dnf install -y passt');
        expect(installCommand('slirp4netns', { osRelease: 'ID=centos\nID_LIKE="rhel fedora"\n', hasDnf: false })).toBe('sudo yum install -y slirp4netns');
        expect(installCommand('pasta', { osRelease: 'ID=arch\n' })).toBeNull();
    });

    const fakeRun = ({ rootless = 'true', version = 'podman version 4.9.3', exe = '' } = {}) => async (command, args) => {
        const text = args.join(' ');
        if (text === '--version') return version;
        if (text.includes('Rootless')) return rootless;
        if (text.includes('Executable')) return exe;
        throw new Error(`unexpected ${text}`);
    };

    test('reports a missing default component, ok when present, and null when not applicable', async () => {
        const base = { command: 'podman', platform: 'linux' };
        expect(await checkRootlessNetwork(fakeRun(), base)).toEqual(expect.objectContaining({ missing: true, component: 'slirp4netns', action: expect.stringContaining('apt-get install -y slirp4netns') }));
        expect(await checkRootlessNetwork(fakeRun({ exe: '/usr/bin/slirp4netns' }), base)).toEqual({ component: 'slirp4netns', missing: false });
        expect(await checkRootlessNetwork(fakeRun({ rootless: 'false' }), base)).toBeNull();
        expect(await checkRootlessNetwork(fakeRun(), { ...base, command: 'docker' })).toBeNull();
        expect(await checkRootlessNetwork(fakeRun(), { ...base, platform: 'darwin' })).toBeNull();
        expect(await checkRootlessNetwork(async () => { throw new Error('boom'); }, base)).toBeNull();
    });
});
