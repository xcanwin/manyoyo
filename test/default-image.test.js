const { DEFAULT_IMAGE_NAME } = require('../lib/default-image');
const { ensureDefaultImage } = require('../lib/image-pull');
const fs = require('fs');
const path = require('path');

describe('默认发布镜像', () => {
    test('默认镜像使用 GHCR 发布地址', () => {
        expect(DEFAULT_IMAGE_NAME).toBe('ghcr.io/xcanwin/manyoyo');
    });

    test('默认镜像不存在时先拉取，已存在或自定义镜像不拉取', () => {
        const calls = [];
        const execute = (args, options = {}) => {
            calls.push({ args, options });
            if (args[0] === 'image' && args[1] === 'inspect') {
                throw new Error('missing');
            }
        };

        expect(ensureDefaultImage({
            imageName: DEFAULT_IMAGE_NAME,
            imageVersion: '1.9.1-common',
            execute,
            log: () => {}
        })).toBe(true);
        expect(calls.map(call => call.args)).toEqual([
            ['image', 'inspect', `${DEFAULT_IMAGE_NAME}:1.9.1-common`],
            ['pull', `${DEFAULT_IMAGE_NAME}:1.9.1-common`]
        ]);

        calls.length = 0;
        expect(ensureDefaultImage({
            imageName: 'example.local/custom',
            imageVersion: '1.9.1-common',
            execute,
            log: () => {}
        })).toBe(false);
        expect(calls).toEqual([]);
    });

    test('拉取失败给出本地 build 兜底动作', () => {
        expect(() => ensureDefaultImage({
            imageName: DEFAULT_IMAGE_NAME,
            imageVersion: '1.9.1-common',
            execute: args => {
                if (args[0] === 'image') {
                    throw new Error('missing');
                }
                throw new Error('registry unavailable');
            },
            log: () => {}
        })).toThrow('manyoyo build --iv 1.9.1-common');
    });

    test('发布工作流构建并推送 amd64 与 arm64 GHCR 镜像', () => {
        const workflow = fs.readFileSync(path.join(__dirname, '../.github/workflows/image-publish.yml'), 'utf8');
        expect(workflow).toContain('platforms: linux/amd64,linux/arm64');
        expect(workflow).toContain('ghcr.io/${{ github.repository_owner }}/manyoyo:${{ steps.version.outputs.image_version }}');
        expect(workflow).toContain('packages: write');
    });
});
