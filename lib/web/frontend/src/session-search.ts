type SearchableSession = {
    name: string;
    containerName: string;
    agentName: string;
};

export function filterSessions<T extends SearchableSession>(sessions: T[], query: string): T[] {
    const normalizedQuery = String(query || '').trim().toLocaleLowerCase();
    if (!normalizedQuery) {
        return sessions;
    }
    return sessions.filter(session => [session.name, session.containerName, session.agentName]
        .some(value => String(value || '').toLocaleLowerCase().includes(normalizedQuery)));
}
