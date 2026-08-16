export type ApiError = {
    code?: string;
    summary?: string;
    detail?: string;
    message?: string;
};

export type Session = {
    name: string;
    containerName: string;
    agentName: string;
    status: string;
    image: string;
    updatedAt: string | null;
    messageCount: number;
};

export type AgentMetadata = {
    id: string;
    aliases: string[];
    capabilities: Record<string, boolean>;
};

export type DoctorReport = {
    ok: boolean;
    checks: Array<{ code: string; status: string; summary: string; action?: string }>;
};

export type CreateOptions = {
    containerName?: string;
    hostPath?: string;
    containerPath?: string;
    imageName?: string;
    imageVersion?: string;
    containerMode?: string;
};

export type WebConfigSnapshot = {
    defaults: CreateOptions;
    parsed: { runs?: Record<string, CreateOptions> };
    raw: string;
    editable: boolean;
    notice: string;
};

export type SessionDetail = Session & {
    applied?: Record<string, unknown>;
    agentPromptCommand?: string;
    resumeSupported?: boolean;
};

export type ControlEvent = {
    type: string;
    data?: Record<string, unknown>;
    seq: number;
};

export type SessionEventsPayload = {
    events: ControlEvent[];
    cursor: number;
};

export type SessionAudit = {
    runSpec: Record<string, unknown> | null;
    events: ControlEvent[];
    projection: Record<string, unknown>;
};

export type FileEntry = {
    name: string;
    path: string;
    kind: 'directory' | 'file' | 'symlink' | 'other';
    size: number;
    mtimeMs: number;
};

export type FileList = {
    path: string;
    parentPath: string;
    entries: FileEntry[];
};

export type FileContent = {
    path: string;
    kind: 'text' | 'binary';
    size: number;
    truncated: boolean;
    editable?: boolean;
    language?: string;
    content?: string;
    revision?: string;
};

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(path, {
        credentials: 'same-origin',
        ...init,
        headers: { 'X-Requested-With': 'XMLHttpRequest', ...(init.headers || {}) }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        const error = payload && payload.error && typeof payload.error === 'object' ? payload.error : payload;
        throw new Error((error as ApiError).summary || (error as ApiError).detail || (error as ApiError).message || `请求失败 (${response.status})`);
    }
    return payload as T;
}

async function requestStream(path: string, init: RequestInit, onEvent: (event: Record<string, unknown>) => void): Promise<void> {
    const response = await fetch(path, {
        credentials: 'same-origin',
        ...init,
        headers: { 'X-Requested-With': 'XMLHttpRequest', ...(init.headers || {}) }
    });
    if (!response.ok || !response.body) {
        const payload = await response.json().catch(() => ({}));
        const error = payload && payload.error && typeof payload.error === 'object' ? payload.error : payload;
        throw new Error((error as ApiError).summary || (error as ApiError).detail || (error as ApiError).message || `请求失败 (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                onEvent(JSON.parse(line));
            } catch {
                // Ignore malformed transport frames; authoritative control events remain persisted server-side.
            }
        }
        if (done) break;
    }
}

export const webApi = {
    listSessions: () => request<{ sessions: Session[] }>('/api/sessions'),
    listAgents: () => request<{ agents: AgentMetadata[] }>('/api/meta/agents'),
    doctor: () => request<DoctorReport>('/api/doctor'),
    listSessionEvents: (name: string, cursor = 0) => request<SessionEventsPayload>(`/api/sessions/${encodeURIComponent(name)}/events?cursor=${encodeURIComponent(String(cursor))}`),
    getConfig: () => request<WebConfigSnapshot>('/api/config'),
    saveConfig: (raw: string) => request<{ saved: boolean }>('/api/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw })
    }),
    createSession: (run: string, createOptions: CreateOptions) => request<{ name: string }>('/api/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ run: run || undefined, createOptions })
    }),
    createAgent: (name: string) => request<{ name: string }>(`/api/sessions/${encodeURIComponent(name)}/agents`, {
        method: 'POST'
    }),
    getSessionDetail: (name: string) => request<{ detail: SessionDetail }>(`/api/sessions/${encodeURIComponent(name)}/detail`),
    getSessionAudit: (name: string) => request<{ name: string; audit: SessionAudit }>(`/api/sessions/${encodeURIComponent(name)}/audit`),
    removeSession: (name: string) => request<{ removed: boolean }>(`/api/sessions/${encodeURIComponent(name)}/remove`, {
        method: 'POST'
    }),
    listFiles: (name: string, filePath = '/') => request<FileList>(`/api/sessions/${encodeURIComponent(name)}/fs/list?path=${encodeURIComponent(filePath)}`),
    readFile: (name: string, filePath: string) => request<FileContent>(`/api/sessions/${encodeURIComponent(name)}/fs/read?path=${encodeURIComponent(filePath)}`),
    writeFile: (name: string, filePath: string, content: string, expectedRevision = '') => request<{ saved: boolean; revision?: string }>(`/api/sessions/${encodeURIComponent(name)}/fs/write`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: filePath, content, expectedRevision })
    }),
    streamAgent: (name: string, prompt: string, onEvent: (event: Record<string, unknown>) => void) => requestStream(
        `/api/sessions/${encodeURIComponent(name)}/agent/stream`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt }) },
        onEvent
    ),
    stopAgent: (name: string) => request<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(name)}/agent/stop`, { method: 'POST' })
};
