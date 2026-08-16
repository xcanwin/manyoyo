import { lazy, Suspense, useEffect, useState, type CSSProperties } from 'react';
import { type AgentMetadata, type CreateOptions, type DoctorReport, type FileContent, type FileEntry, type Session, type SessionDetail, type WebConfigSnapshot, webApi } from './api';
import { type ActivityEvent, createActivityState, reduceActivityEvent } from './event-reducer';
import { filterSessions } from './session-search';
import { MarkdownMessage } from './MarkdownMessage';
import { getLocale, translate, type Locale } from './i18n';
import './styles.css';

type WorkspaceTab = 'terminal' | 'files' | 'details' | 'config' | 'doctor';
type Theme = 'light' | 'dark';
const WORKSPACE_TAB_LABELS: Record<WorkspaceTab, Parameters<typeof translate>[1]> = {
    terminal: 'terminal',
    files: 'files',
    details: 'details',
    config: 'configuration',
    doctor: 'doctor'
};
const TerminalView = lazy(() => import('./TerminalView'));
const CodeEditor = lazy(() => import('./CodeEditor'));

const EMPTY_CREATE_FORM: Required<CreateOptions> = {
    containerName: '',
    hostPath: '',
    containerPath: '',
    imageName: '',
    imageVersion: '',
    containerMode: 'common'
};

function toCreateForm(value: CreateOptions = {}): Required<CreateOptions> {
    return { ...EMPTY_CREATE_FORM, ...value, containerMode: value.containerMode || 'common' };
}

export function App() {
    const [theme, setTheme] = useState<Theme>(() => window.localStorage.getItem('manyoyo-theme') === 'dark' ? 'dark' : 'light');
    const [locale, setLocale] = useState<Locale>(() => getLocale(window.localStorage.getItem('manyoyo-locale')));
    const [workspaceWidth, setWorkspaceWidth] = useState(() => {
        const saved = Number(window.localStorage.getItem('manyoyo-workspace-width'));
        return saved >= 280 && saved <= 640 ? saved : 330;
    });
    const [sessions, setSessions] = useState<Session[]>([]);
    const [sessionQuery, setSessionQuery] = useState('');
    const [agents, setAgents] = useState<AgentMetadata[]>([]);
    const [doctor, setDoctor] = useState<DoctorReport | null>(null);
    const [activeSession, setActiveSession] = useState<string>('');
    const [activeTab, setActiveTab] = useState<WorkspaceTab>('details');
    const [activity, setActivity] = useState(createActivityState);
    const [eventCursor, setEventCursor] = useState(0);
    const [offline, setOffline] = useState(false);
    const [detail, setDetail] = useState<SessionDetail | null>(null);
    const [config, setConfig] = useState<WebConfigSnapshot | null>(null);
    const [configText, setConfigText] = useState('');
    const [savingConfig, setSavingConfig] = useState(false);
    const [filePath, setFilePath] = useState('/');
    const [fileEntries, setFileEntries] = useState<FileEntry[]>([]);
    const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
    const [fileText, setFileText] = useState('');
    const [savingFile, setSavingFile] = useState(false);
    const [fileConflict, setFileConflict] = useState(false);
    const [createOpen, setCreateOpen] = useState(false);
    const [createRun, setCreateRun] = useState('');
    const [createForm, setCreateForm] = useState<Required<CreateOptions>>(EMPTY_CREATE_FORM);
    const [creating, setCreating] = useState(false);
    const [creatingAgent, setCreatingAgent] = useState(false);
    const [prompt, setPrompt] = useState('');
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    const refresh = async () => {
        setLoading(true);
        setError('');
        try {
            const [sessionPayload, agentPayload, doctorPayload, configPayload] = await Promise.all([
                webApi.listSessions(),
                webApi.listAgents(),
                webApi.doctor(),
                webApi.getConfig()
            ]);
            setSessions(sessionPayload.sessions);
            setAgents(agentPayload.agents);
            setDoctor(doctorPayload);
            setConfig(configPayload);
            setConfigText(configPayload.raw || '');
            setOffline(false);
            setCreateForm(current => current.containerName ? current : toCreateForm(configPayload.defaults));
            setActiveSession(current => current || sessionPayload.sessions[0]?.name || '');
        } catch (requestError) {
            setOffline(true);
            setError(requestError instanceof Error ? requestError.message : t('connectWebServiceFailed'));
        } finally {
            setLoading(false);
        }
    };

    useEffect(() => {
        void refresh();
    }, []);

    useEffect(() => {
        document.documentElement.dataset.theme = theme;
        window.localStorage.setItem('manyoyo-theme', theme);
    }, [theme]);

    useEffect(() => {
        document.documentElement.lang = locale === 'en' ? 'en' : 'zh-CN';
        window.localStorage.setItem('manyoyo-locale', locale);
    }, [locale]);

    useEffect(() => {
        window.localStorage.setItem('manyoyo-workspace-width', String(workspaceWidth));
    }, [workspaceWidth]);

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
                event.preventDefault();
                document.getElementById('session-search')?.focus();
            }
            if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'n') {
                event.preventDefault();
                setCreateOpen(true);
            }
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                void sendPrompt();
            }
            if (event.key === 'Escape' && createOpen) {
                setCreateOpen(false);
            }
            if (event.key === 'Escape' && sending) {
                void stopPrompt();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [createOpen, sending, prompt, activeSession]);

    useEffect(() => {
        if (!activeSession) {
            setActivity(createActivityState());
            setEventCursor(0);
            setDetail(null);
            return;
        }
        void Promise.all([webApi.listSessionEvents(activeSession), webApi.getSessionDetail(activeSession)])
            .then(([eventPayload, detailPayload]) => {
                setActivity(eventPayload.events.reduce(reduceActivityEvent, createActivityState()));
                setEventCursor(eventPayload.cursor);
                setDetail(detailPayload.detail);
                setOffline(false);
            })
            .catch(requestError => {
                setOffline(true);
                setError(requestError instanceof Error ? requestError.message : t('readSessionFailed'));
            });
    }, [activeSession]);

    useEffect(() => {
        if (!activeSession) return;
        let disposed = false;
        const recoverEvents = async () => {
            try {
                const payload = await webApi.listSessionEvents(activeSession, eventCursor);
                if (disposed) return;
                if (payload.events.length) {
                    setActivity(current => payload.events.reduce(reduceActivityEvent, current));
                    setEventCursor(payload.cursor);
                }
                setOffline(false);
            } catch {
                if (!disposed) setOffline(true);
            }
        };
        const timer = window.setInterval(() => { void recoverEvents(); }, 2000);
        return () => {
            disposed = true;
            window.clearInterval(timer);
        };
    }, [activeSession, eventCursor]);

    const loadFiles = async (nextPath = filePath) => {
        if (!activeSession) return;
        setError('');
        try {
            const payload = await webApi.listFiles(activeSession, nextPath);
            setFilePath(payload.path);
            setFileEntries(payload.entries);
                setSelectedFile(null);
                setFileText('');
                setFileConflict(false);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('readFilesFailed'));
        }
    };

    useEffect(() => {
        if (activeTab === 'files' && activeSession) {
            void loadFiles('/');
        }
    }, [activeSession, activeTab]);

    const selected = sessions.find(session => session.name === activeSession);
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    const visibleSessions = filterSessions(sessions, sessionQuery);
    const runs = config?.parsed.runs || {};
    const updateCreateField = (field: keyof CreateOptions, value: string) => {
        setCreateForm(current => ({ ...current, [field]: value }));
    };
    const selectCreateRun = (run: string) => {
        setCreateRun(run);
        setCreateForm(toCreateForm({ ...(config?.defaults || {}), ...(run ? runs[run] || {} : {}) }));
    };
    const submitCreate = async () => {
        setCreating(true);
        setError('');
        try {
            const result = await webApi.createSession(createRun, createForm);
            const sessionPayload = await webApi.listSessions();
            setSessions(sessionPayload.sessions);
            setActiveSession(sessionPayload.sessions.find(session => session.containerName === result.name)?.name || result.name);
            setCreateOpen(false);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('createSessionFailed'));
        } finally {
            setCreating(false);
        }
    };
    const removeActiveSession = async () => {
        if (!activeSession) return;
        setError('');
        try {
            await webApi.removeSession(activeSession);
            setActiveSession('');
            await refresh();
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('removeSessionFailed'));
        }
    };
    const createAgent = async () => {
        if (!activeSession || creatingAgent) return;
        setCreatingAgent(true);
        setError('');
        try {
            const created = await webApi.createAgent(activeSession);
            await refresh();
            setActiveSession(created.name);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('createAgentFailed'));
        } finally {
            setCreatingAgent(false);
        }
    };
    const sendPrompt = async () => {
        if (!activeSession || !prompt.trim() || sending) return;
        setSending(true);
        setError('');
        setActivity(current => reduceActivityEvent(current, { type: 'agent.turn.started' }));
        try {
            await webApi.streamAgent(activeSession, prompt.trim(), event => {
                const controlEvent = event.controlEvent as ActivityEvent | undefined;
                if (controlEvent) {
                    setActivity(current => reduceActivityEvent(current, controlEvent));
                    const controlCursor = Number((event.controlEvent as { seq?: number }).seq || 0);
                    if (controlCursor > 0) setEventCursor(current => Math.max(current, controlCursor));
                }
            });
            setPrompt('');
            await refresh();
        } catch (requestError) {
            const message = requestError instanceof Error ? requestError.message : t('agentFailed');
            setError(message);
            setActivity(current => reduceActivityEvent(current, { type: 'agent.turn.failed', data: { error: message } }));
        } finally {
            setSending(false);
        }
    };
    const stopPrompt = async () => {
        if (!activeSession || !sending) return;
        try {
            await webApi.stopAgent(activeSession);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('stopAgentFailed'));
        }
    };
    const openFile = async (entry: FileEntry) => {
        if (entry.kind === 'directory') {
            await loadFiles(entry.path);
            return;
        }
        if (entry.kind !== 'file' || !activeSession) return;
        setError('');
        try {
            const payload = await webApi.readFile(activeSession, entry.path);
                setSelectedFile(payload);
                setFileText(payload.content || '');
                setFileConflict(false);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('readFileFailed'));
        }
    };
    const saveFile = async () => {
        if (!activeSession || !selectedFile || !selectedFile.editable || savingFile) return;
        setSavingFile(true);
        setError('');
        try {
                const result = await webApi.writeFile(activeSession, selectedFile.path, fileText, selectedFile.revision);
                setSelectedFile(current => current ? { ...current, content: fileText, revision: result.revision || current.revision } : current);
                setFileConflict(false);
            } catch (requestError) {
                setFileConflict(requestError instanceof Error && requestError.message.includes('外部修改'));
                setError(requestError instanceof Error ? requestError.message : t('saveFileFailed'));
        } finally {
            setSavingFile(false);
        }
    };
    const saveConfig = async () => {
        if (!config?.editable || savingConfig) return;
        setSavingConfig(true);
        setError('');
        try {
            await webApi.saveConfig(configText);
            await refresh();
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('saveConfigFailed'));
        } finally {
            setSavingConfig(false);
        }
    };
    const exportAudit = async () => {
        if (!activeSession) return;
        setError('');
        try {
            const payload = await webApi.getSessionAudit(activeSession);
            const blob = new Blob([JSON.stringify(payload.audit, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `${activeSession}-audit.json`;
            link.click();
            URL.revokeObjectURL(url);
        } catch (requestError) {
            setError(requestError instanceof Error ? requestError.message : t('exportAuditFailed'));
        }
    };
    return (
        <main className="workbench" style={{ '--workspace-width': `${workspaceWidth}px` } as CSSProperties}>
            <aside className="sessions-panel" aria-label={t('sessions')}>
                <div className="panel-heading">
                    <div>
                        <strong>MANYOYO</strong>
                        <span>{t('workbench')}</span>
                    </div>
                    <div className="panel-actions"><button type="button" onClick={() => setTheme(current => current === 'light' ? 'dark' : 'light')}>{theme === 'light' ? t('darkTheme') : t('lightTheme')}</button><button type="button" onClick={() => setLocale(current => current === 'zh' ? 'en' : 'zh')}>{locale === 'zh' ? 'EN' : '中文'}</button><button type="button" onClick={() => setCreateOpen(true)}>{t('newSession')}</button><button type="button" onClick={() => void refresh()}>{t('refresh')}</button></div>
                </div>
                <input id="session-search" className="session-search" value={sessionQuery} onChange={event => setSessionQuery(event.target.value)} placeholder={t('searchSessions')} aria-label={t('searchSessions')} />
                {loading ? <p className="muted">{t('loading')}</p> : null}
                {!loading && sessions.length === 0 ? <p className="muted">{t('noSessions')}</p> : null}
                {!loading && sessions.length > 0 && visibleSessions.length === 0 ? <p className="muted">{t('noMatches')}</p> : null}
                <nav role="tree" aria-label={t('sessionTree')}>
                    {visibleSessions.map(session => (
                        <button
                            type="button"
                            role="treeitem"
                            aria-selected={session.name === activeSession}
                            className={session.name === activeSession ? 'session active' : 'session'}
                            key={session.name}
                            onClick={() => setActiveSession(session.name)}
                        >
                            <strong>{session.agentName || session.containerName}</strong>
                            <span>{session.status} · {session.messageCount} {t('messages')}</span>
                        </button>
                    ))}
                </nav>
            </aside>
            <section className="activity-panel" aria-label={t('activity')}>
                <header>
                    <div>
                        <h1>{selected?.containerName || t('chooseSession')}</h1>
                        <p>{selected ? `${selected.status} · ${selected.image || t('imageNotRecorded')}` : t('activityDescription')}</p>
                    </div>
                    {selected ? <div className="header-actions"><button type="button" onClick={() => void createAgent()} disabled={creatingAgent}>{creatingAgent ? t('creating') : t('newAgent')}</button><button type="button" className="danger" onClick={() => void removeActiveSession()}>{t('removeContainer')}</button></div> : null}
                </header>
                {error ? <div className="app-error" role="alert">{error}</div> : null}
                {offline ? <div className="app-error" role="status">{t('offline')}</div> : null}
                <div className="activity-stream" aria-live="polite">
                    {!selected ? <div className="activity-empty"><strong>{t('gettingStarted')}</strong><p>{t('selectSessionActivity')}</p></div> : null}
                    {selected && activity.output.length === 0 ? <div className="activity-empty"><strong>{t('activityAppears')}</strong><p>{t('activityMigrationNotice')}</p></div> : null}
                    {activity.output.map((line, index) => <pre className="activity-output" key={`${index}-${line}`}>{line}</pre>)}
                    {activity.tools.map((tool, index) => <div className="tool-card" key={`${index}-${tool.name}`}><strong>{tool.name}</strong><span>{tool.text}</span></div>)}
                    {activity.childSessions.map(child => <div className="tool-card" key={child.id}><strong>{child.agentProgram || 'Agent'}</strong><span>{child.id} · {child.status}</span></div>)}
                    {activity.finalMessage ? <MarkdownMessage className="final-message" value={activity.finalMessage} /> : null}
                    {activity.interrupted ? <div className="interrupted">{t('interrupted')}</div> : null}
                </div>
                <footer className="composer" aria-label={t('messageInput')}>
                    <input value={prompt} disabled={!selected || sending} onChange={event => setPrompt(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void sendPrompt(); } }} placeholder={selected ? t('enterPrompt') : t('selectSession')} />
                    {sending ? <button type="button" className="danger" onClick={() => void stopPrompt()}>{t('stop')}</button> : <button type="button" disabled={!selected || !prompt.trim()} onClick={() => void sendPrompt()}>{t('send')}</button>}
                </footer>
            </section>
            <aside className="workspace-panel" aria-label={t('workspace')}>
                <label className="workspace-width-control">{t('workspaceWidth')}<input type="range" min="280" max="640" value={workspaceWidth} onChange={event => setWorkspaceWidth(Number(event.target.value))} aria-label={t('workspaceWidth')} /></label>
                <div className="tabs" role="tablist" aria-label={t('workspaceTabs')}>
                    {(['terminal', 'files', 'details', 'config', 'doctor'] as WorkspaceTab[]).map(tab => (
                        <button
                            type="button"
                            key={tab}
                            className={activeTab === tab ? 'active' : ''}
                            onClick={() => setActiveTab(tab)}
                        >{t(WORKSPACE_TAB_LABELS[tab])}</button>
                    ))}
                </div>
                {activeTab === 'terminal' && activeSession ? <Suspense fallback={<p className="muted">{t('loadingTerminal')}</p>}><TerminalView sessionName={activeSession} locale={locale} /></Suspense> : null}
                {activeTab === 'doctor' ? (
                    <ul className="doctor-list">
                        {(doctor?.checks || []).map(check => <li key={check.code}><strong>{check.status}</strong> {check.summary}</li>)}
                    </ul>
                ) : null}
                {activeTab === 'files' ? <section className="files-panel"><header><button type="button" disabled={!activeSession || !filePath || filePath === '/'} onClick={() => void loadFiles(filePath.slice(0, filePath.lastIndexOf('/')) || '/')}>{t('parentDirectory')}</button><code>{filePath}</code><button type="button" disabled={!activeSession} onClick={() => void loadFiles()}>{t('refresh')}</button></header><div className="file-workspace"><nav aria-label={t('fileList')}>{fileEntries.map(entry => <button type="button" key={entry.path} className={selectedFile?.path === entry.path ? 'active' : ''} onClick={() => void openFile(entry)}><span>{entry.kind === 'directory' ? '📁' : '📄'} {entry.name}</span><small>{entry.kind === 'file' ? `${entry.size} B` : entry.kind}</small></button>)}</nav><div className="file-editor">{!selectedFile ? <p className="muted">{t('selectFile')}</p> : null}{selectedFile?.kind === 'binary' ? <p className="muted">{t('binaryFile')} {selectedFile.size} B，{t('cannotEdit')}</p> : null}{selectedFile?.kind === 'text' ? <><header><code>{selectedFile.path}</code><button type="button" disabled={!selectedFile.editable || savingFile} onClick={() => void saveFile()}>{savingFile ? t('saving') : t('save')}</button></header>{fileConflict ? <p className="app-error">{t('fileConflict')}<button type="button" onClick={() => void openFile({ name: selectedFile.path.split('/').pop() || selectedFile.path, path: selectedFile.path, kind: 'file', size: selectedFile.size, mtimeMs: 0 })}>{t('reload')}</button></p> : null}{selectedFile.truncated ? <p className="app-error">{t('filePreviewTruncated')}</p> : null}<Suspense fallback={<p className="muted">{t('loadingEditor')}</p>}><CodeEditor ariaLabel={t('fileContent')} value={fileText} readOnly={!selectedFile.editable} language={selectedFile.language} onChange={setFileText} /></Suspense></> : null}</div></div></section> : null}
                {activeTab === 'details' ? <section className="details-panel"><button type="button" disabled={!activeSession} onClick={() => void exportAudit()}>{t('exportAudit')}</button><pre>{JSON.stringify(detail || selected || { agents: agents.map(agent => agent.id) }, null, 2)}</pre></section> : null}
                {activeTab === 'config' ? <section className="config-panel"><p className="muted">{config?.notice || t('loading')}</p><Suspense fallback={<p className="muted">{t('loadingEditor')}</p>}><CodeEditor ariaLabel={t('configuration')} value={configText} readOnly={!config?.editable} language="javascript" onChange={setConfigText} /></Suspense><button type="button" disabled={!config?.editable || savingConfig} onClick={() => void saveConfig()}>{savingConfig ? t('saving') : t('saveConfig')}</button></section> : null}
            </aside>
            {createOpen ? <section className="create-dialog" role="dialog" aria-modal="true" aria-label={t('createContainer')}>
                <form onSubmit={event => { event.preventDefault(); void submitCreate(); }}>
                    <header><h2>{t('createContainer')}</h2><button type="button" onClick={() => setCreateOpen(false)}>{t('close')}</button></header>
                    <label>{t('runConfig')}<select value={createRun} onChange={event => selectCreateRun(event.target.value)}><option value="">{t('defaultConfig')}</option>{Object.keys(runs).sort().map(run => <option key={run} value={run}>{run}</option>)}</select></label>
                    <label>{t('name')}<input required value={createForm.containerName} onChange={event => updateCreateField('containerName', event.target.value)} /></label>
                    <label>{t('hostPath')}<input required value={createForm.hostPath} onChange={event => updateCreateField('hostPath', event.target.value)} /></label>
                    <label>{t('mode')}<select value={createForm.containerMode} onChange={event => updateCreateField('containerMode', event.target.value)}><option value="common">common</option><option value="dind">dind</option><option value="sock">sock</option></select></label>
                    <details><summary>{t('advancedOptions')}</summary><label>{t('containerPath')}<input required value={createForm.containerPath} onChange={event => updateCreateField('containerPath', event.target.value)} /></label><label>{t('imageName')}<input value={createForm.imageName} onChange={event => updateCreateField('imageName', event.target.value)} /></label><label>{t('imageVersion')}<input value={createForm.imageVersion} onChange={event => updateCreateField('imageVersion', event.target.value)} /></label></details>
                    <footer><button type="button" onClick={() => setCreateOpen(false)}>{t('cancel')}</button><button type="submit" disabled={creating}>{creating ? t('loading') : t('create')}</button></footer>
                </form>
            </section> : null}
        </main>
    );
}
