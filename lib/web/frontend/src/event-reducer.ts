export type ActivityEvent = {
    type: string;
    data?: Record<string, unknown>;
};

export type ActivityTool = {
    name: string;
    text: string;
};

export type ChildSession = {
    id: string;
    agentProgram: string;
    status: 'observed' | 'completed' | 'failed';
};

export type ActivityState = {
    status: 'idle' | 'running' | 'completed' | 'interrupted' | 'failed';
    output: string[];
    tools: ActivityTool[];
    childSessions: ChildSession[];
    finalMessage: string;
    error: string;
    interrupted: boolean;
    isStreamingDelta: boolean;
};

export function createActivityState(): ActivityState {
    return {
        status: 'idle',
        output: [],
        tools: [],
        childSessions: [],
        finalMessage: '',
        error: '',
        interrupted: false,
        isStreamingDelta: false
    };
}

function textFromEvent(event: ActivityEvent): string {
    const value = event.data?.text ?? event.data?.content ?? event.data?.error ?? '';
    return String(value || '');
}

export function reduceActivityEvent(state: ActivityState, event: ActivityEvent): ActivityState {
    const data = event.data || {};
    if (event.type === 'process.stdout' || event.type === 'process.stderr') {
        const text = textFromEvent(event);
        return text
            ? { ...state, status: 'running', output: [...state.output, text], isStreamingDelta: false }
            : state;
    }
    if (event.type === 'agent.turn.started' || event.type === 'process.started') {
        return { ...state, status: 'running', interrupted: false, error: '' };
    }
    if (event.type === 'agent.turn.delta') {
        const text = textFromEvent(event);
        if (!text) return state;
        const output = state.isStreamingDelta && state.output.length > 0
            ? [...state.output.slice(0, -1), `${state.output[state.output.length - 1]}${text}`]
            : [...state.output, text];
        return { ...state, status: 'running', output, isStreamingDelta: true };
    }
    if (event.type === 'agent.tool.observed') {
        return {
            ...state,
            tools: [...state.tools, {
                name: String(data.name || data.tool || 'tool'),
                text: textFromEvent(event)
            }]
        };
    }
    if (event.type === 'agent.child.observed') {
        const id = String(data.childSessionId || '');
        if (!id || state.childSessions.some(child => child.id === id)) return state;
        return { ...state, childSessions: [...state.childSessions, { id, agentProgram: String(data.agentProgram || ''), status: 'observed' }] };
    }
    if (event.type === 'agent.child.completed' || event.type === 'agent.child.failed') {
        const id = String(data.childSessionId || '');
        if (!id) return state;
        const status = event.type === 'agent.child.completed' ? 'completed' : 'failed';
        return { ...state, childSessions: state.childSessions.map(child => child.id === id ? { ...child, status } : child) };
    }
    if (event.type === 'agent.message.completed') {
        return { ...state, finalMessage: textFromEvent(event), isStreamingDelta: false };
    }
    if (event.type === 'process.interrupted' || event.type === 'session.stopped') {
        return { ...state, status: 'interrupted', interrupted: true, isStreamingDelta: false };
    }
    if (event.type === 'agent.turn.failed' || event.type === 'session.failed') {
        return { ...state, status: 'failed', error: textFromEvent(event), isStreamingDelta: false };
    }
    if (event.type === 'process.exited') {
        const exitCode = Number(data.exitCode);
        return {
            ...state,
            status: exitCode === 0 ? 'completed' : 'failed',
            error: exitCode === 0 ? state.error : (state.error || `进程以退出码 ${exitCode} 结束`),
            isStreamingDelta: false
        };
    }
    return state;
}
