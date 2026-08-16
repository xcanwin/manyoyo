'use strict';

function buildTerminalBootstrap() {
    return [
        'MANYOYO_WEB_BASHRC="$(mktemp /tmp/manyoyo-web-bashrc.XXXXXX 2>/dev/null || mktemp)"',
        'cat > "$MANYOYO_WEB_BASHRC" <<\'EOF_MANYOYO_RC\'',
        'if [ -f /etc/bash.bashrc ]; then',
        '    . /etc/bash.bashrc',
        'fi',
        'if [ -f ~/.bashrc ]; then',
        '    . ~/.bashrc',
        'fi',
        'EOF_MANYOYO_RC',
        'chmod 600 "$MANYOYO_WEB_BASHRC" >/dev/null 2>&1 || true',
        'exec /bin/bash --rcfile "$MANYOYO_WEB_BASHRC" -i'
    ].join('\n');
}

function createTerminalProcess(options = {}) {
    const pty = options.pty || require('node-pty');
    const cols = Number(options.cols) || 120;
    const rows = Number(options.rows) || 36;
    const env = options.env || process.env;
    const term = env.TERM && env.TERM !== 'dumb' ? env.TERM : 'xterm-256color';
    const colorTerm = env.COLORTERM || 'truecolor';
    const args = [
        'exec',
        '-it',
        '-e', `TERM=${term}`,
        '-e', `COLORTERM=${colorTerm}`,
        '-e', `MANYOYO_TERM_COLS=${String(cols)}`,
        '-e', `MANYOYO_TERM_ROWS=${String(rows)}`,
        options.containerName,
        '/bin/bash',
        '-lc',
        buildTerminalBootstrap()
    ];
    const rawPty = pty.spawn(options.dockerCmd, args, {
        name: term,
        cols,
        rows,
        cwd: options.cwd || process.cwd(),
        env: {
            ...process.env,
            TERM: term,
            COLORTERM: colorTerm
        }
    });
    return {
        write(data) {
            rawPty.write(data);
        },
        resize(nextCols, nextRows) {
            rawPty.resize(nextCols, nextRows);
        },
        kill() {
            rawPty.kill();
        },
        onData(callback) {
            return rawPty.onData(callback);
        },
        onExit(callback) {
            return rawPty.onExit(event => callback(event.exitCode, event.signal));
        }
    };
}

module.exports = {
    buildTerminalBootstrap,
    createTerminalProcess
};
