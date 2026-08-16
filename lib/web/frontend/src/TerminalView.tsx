import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { translate, type Locale } from './i18n';
import '@xterm/xterm/css/xterm.css';

type TerminalViewProps = {
    sessionName: string;
    locale: Locale;
};

function buildTerminalUrl(sessionName: string, cols: number, rows: number) {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = new URL(`/api/sessions/${encodeURIComponent(sessionName)}/terminal/ws`, `${protocol}//${window.location.host}`);
    url.searchParams.set('cols', String(cols));
    url.searchParams.set('rows', String(rows));
    return url;
}

export function TerminalView({ sessionName, locale }: TerminalViewProps) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const [status, setStatus] = useState(() => translate(locale, 'terminalConnecting'));

    useEffect(() => {
        const host = hostRef.current;
        if (!host || !sessionName) return;
        const terminal = new Terminal({
            cursorBlink: true,
            convertEol: true,
            fontSize: 13,
            theme: { background: '#172033', foreground: '#eff6ff' }
        });
        const fitAddon = new FitAddon();
        terminal.loadAddon(fitAddon);
        terminal.open(host);
        fitAddon.fit();
        const socket = new WebSocket(buildTerminalUrl(sessionName, terminal.cols, terminal.rows));
        const sendResize = () => {
            fitAddon.fit();
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows }));
            }
        };
        const resizeObserver = new ResizeObserver(sendResize);
        resizeObserver.observe(host);
        const dataDisposable = terminal.onData(data => {
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({ type: 'input', data }));
            }
        });
        socket.addEventListener('open', () => {
            setStatus(translate(locale, 'terminalConnected'));
            sendResize();
        });
        socket.addEventListener('message', event => {
            try {
                const payload = JSON.parse(String(event.data)) as { type?: string; data?: string; error?: string; phase?: string };
                if (payload.type === 'output' && payload.data) terminal.write(payload.data);
                if (payload.type === 'error') setStatus(payload.error || translate(locale, 'terminalError'));
                if (payload.type === 'status' && payload.phase === 'closed') setStatus(translate(locale, 'terminalClosed'));
            } catch {
                terminal.write(String(event.data));
            }
        });
        socket.addEventListener('error', () => setStatus(translate(locale, 'terminalError')));
        socket.addEventListener('close', () => setStatus(current => current === translate(locale, 'terminalClosed') ? current : translate(locale, 'disconnected')));
        return () => {
            resizeObserver.disconnect();
            dataDisposable.dispose();
            if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'close' }));
            socket.close();
            terminal.dispose();
        };
    }, [locale, sessionName]);

    return <section className="terminal-panel"><span className="muted">{status}</span><div className="xterm-host" ref={hostRef} aria-label={translate(locale, 'containerTerminal')} /></section>;
}

export default TerminalView;
