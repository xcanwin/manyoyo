const { registerPlaywrightAliasCommands } = require('../lib/cli/commands/playwright');
const { registerConfigCommands } = require('../lib/cli/commands/config');
const { registerCoreCommands } = require('../lib/cli/commands/core');

function createCommand() {
    const command = {
        children: {},
        command(name) {
            const child = createCommand();
            this.children[name] = child;
            return child;
        },
        description() {
            return this;
        },
        addHelpText() {
            return this;
        },
        option() {
            return this;
        },
        action(handler) {
            this.handler = handler;
            return this;
        }
    };
    return command;
}

describe('Playwright CLI 命令装配', () => {
    test('up 命令保留场景、运行配置与扩展参数', () => {
        const selected = [];
        const command = createCommand();
        registerPlaywrightAliasCommands(command, {
            appendArrayOption(target, flags, description) {
                target.option(flags, description, (value, previous = []) => [...previous, value]);
            },
            selectPluginAction(params, options) {
                selected.push({ params, options });
            }
        });

        command.children['up [scene]'].handler('cli-host-headed', {
            run: 'demo',
            extPath: ['/tmp/a', '/tmp/b'],
            extName: []
        });

        expect(selected).toEqual([{
            params: {
                action: 'up',
                pluginName: 'playwright',
                scene: 'cli-host-headed',
                extensionPaths: ['/tmp/a', '/tmp/b'],
                extensionNames: []
            },
            options: expect.objectContaining({ run: 'demo', extPath: ['/tmp/a', '/tmp/b'] })
        }]);
    });

    test('mcp-add 与 cli-add 使用既有默认场景', () => {
        const selected = [];
        const command = createCommand();
        registerPlaywrightAliasCommands(command, {
            appendArrayOption() {},
            selectPluginAction(params, options) {
                selected.push({ params, options });
            }
        });

        command.children['mcp-add'].handler({ host: 'localhost' });
        command.children['cli-add'].handler();

        expect(selected).toEqual([
            { params: { action: 'mcp-add', pluginName: 'playwright', scene: 'all', host: 'localhost' }, options: expect.objectContaining({ host: 'localhost' }) },
            { params: { action: 'cli-add', pluginName: 'playwright', scene: 'all' }, options: undefined }
        ]);
    });
});

describe('配置 CLI 命令装配', () => {
    test('config show 保留 serve 预览认证参数与 provenance 开关', () => {
        const selected = [];
        const command = createCommand();
        const applyRunStyleOptions = jest.fn();
        const enableShellSuffixPassThrough = jest.fn();
        const validateShellSuffixPassThroughArgs = jest.fn();
        registerConfigCommands(command, {
            applyRunStyleOptions,
            enableShellSuffixPassThrough,
            validateShellSuffixPassThroughArgs,
            selectAction: (action, options) => selected.push({ action, options })
        });

        const configCommand = command.children.config;
        configCommand.children.show.handler({
            explain: true,
            serve: '127.0.0.1:3000',
            user: 'admin',
            pass: 'secret',
            trustProxy: true
        }, {});

        expect(applyRunStyleOptions).toHaveBeenCalledWith(configCommand.children.show, { includeRmOnExit: false, includeServePreview: true });
        expect(enableShellSuffixPassThrough).toHaveBeenCalledWith(configCommand.children.show);
        expect(validateShellSuffixPassThroughArgs).toHaveBeenCalled();
        expect(selected).toEqual([{
            action: 'config-show',
            options: expect.objectContaining({
                showConfig: true,
                server: '127.0.0.1:3000',
                serverUser: 'admin',
                serverPass: 'secret',
                serverTrustProxy: true
            })
        }]);
    });
});

describe('核心 CLI 命令装配', () => {
    test('run、serve 和 doctor 保持既有 action 参数语义', () => {
        const selected = [];
        const command = createCommand();
        const applyRunStyleOptions = jest.fn();
        const enableShellSuffixPassThrough = jest.fn();
        const validateShellSuffixPassThroughArgs = jest.fn();
        registerCoreCommands(command, {
            manyoyoName: 'manyoyo',
            imageVersionHelpExample: '1.9.1-common',
            applyRunStyleOptions,
            appendArrayOption: jest.fn(),
            enableShellSuffixPassThrough,
            validateShellSuffixPassThroughArgs,
            selectAction: (action, options) => selected.push({ action, options })
        });

        command.children.run.handler({ run: 'codex' }, {});
        command.children['serve [listen]'].handler('127.0.0.1:3000', { user: 'admin', pass: 'secret', trustProxy: true });
        command.children.doctor.handler({ json: true });

        expect(validateShellSuffixPassThroughArgs).toHaveBeenCalled();
        expect(selected).toEqual([
            { action: 'run', options: { run: 'codex' } },
            { action: 'serve', options: expect.objectContaining({ server: '127.0.0.1:3000', serverUser: 'admin', serverPass: 'secret', serverTrustProxy: true }) },
            { action: 'doctor', options: { json: true, doctor: true } }
        ]);
        expect(applyRunStyleOptions).toHaveBeenCalledWith(command.children.run);
        expect(applyRunStyleOptions).toHaveBeenCalledWith(command.children['serve [listen]'], { includeRmOnExit: false, includeWebAuthOptions: true });
    });
});
