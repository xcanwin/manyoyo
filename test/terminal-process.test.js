const { createTerminalProcess } = require('../lib/web/terminal-process');

describe('Web terminal PTY process', () => {
    test('starts docker exec in a PTY and forwards input, resize and exit', () => {
        const callbacks = {};
        const rawPty = {
            write: jest.fn(),
            resize: jest.fn(),
            kill: jest.fn(),
            onData: callback => { callbacks.data = callback; return { dispose() {} }; },
            onExit: callback => { callbacks.exit = callback; return { dispose() {} }; }
        };
        const pty = { spawn: jest.fn(() => rawPty) };
        const process = createTerminalProcess({
            pty,
            dockerCmd: 'docker',
            containerName: 'demo',
            cols: 132,
            rows: 41,
            env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' }
        });

        expect(pty.spawn).toHaveBeenCalledWith('docker', expect.arrayContaining([
            'exec', '-it', 'demo', '/bin/bash', '-lc'
        ]), expect.objectContaining({ cols: 132, rows: 41, name: 'xterm-256color' }));
        process.write('ls\n');
        process.resize(100, 30);
        process.kill();
        expect(rawPty.write).toHaveBeenCalledWith('ls\n');
        expect(rawPty.resize).toHaveBeenCalledWith(100, 30);
        expect(rawPty.kill).toHaveBeenCalled();

        const output = jest.fn();
        const exited = jest.fn();
        process.onData(output);
        process.onExit(exited);
        callbacks.data('hello');
        callbacks.exit({ exitCode: 0, signal: 0 });
        expect(output).toHaveBeenCalledWith('hello');
        expect(exited).toHaveBeenCalledWith(0, 0);
    });
});
