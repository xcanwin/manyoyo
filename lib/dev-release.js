function parseReleaseVersion(version) {
    const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match) {
        return null;
    }
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3])
    };
}

function formatReleaseVersion(parts) {
    return `${parts.major}.${parts.minor}.${parts.patch}`;
}

function compareReleaseVersions(left, right) {
    const a = typeof left === 'string' ? parseReleaseVersion(left) : left;
    const b = typeof right === 'string' ? parseReleaseVersion(right) : right;
    if (!a || !b) {
        return 0;
    }
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    return a.patch - b.patch;
}

function buildVersionSuggestions(version) {
    const parsed = parseReleaseVersion(version);
    if (!parsed) {
        return [];
    }
    return [
        {
            key: 'patch',
            label: '第3段 +1 (patch)',
            version: formatReleaseVersion({
                major: parsed.major,
                minor: parsed.minor,
                patch: parsed.patch + 1
            }),
            recommended: true
        },
        {
            key: 'minor',
            label: '第2段 +1 (minor)',
            version: formatReleaseVersion({
                major: parsed.major,
                minor: parsed.minor + 1,
                patch: 0
            }),
            recommended: false
        },
        {
            key: 'major',
            label: '第1段 +1 (major)',
            version: formatReleaseVersion({
                major: parsed.major + 1,
                minor: 0,
                patch: 0
            }),
            recommended: false
        }
    ];
}

function pickLatestVersionTag(tags) {
    let latest = null;
    for (const rawTag of (tags || [])) {
        const tag = String(rawTag || '').trim();
        if (!tag) {
            continue;
        }
        const normalized = tag.startsWith('v') ? tag.slice(1) : tag;
        const parsed = parseReleaseVersion(normalized);
        if (!parsed) {
            continue;
        }
        if (!latest || compareReleaseVersions(parsed, latest.parsed) > 0) {
            latest = {
                tag,
                version: normalized,
                parsed
            };
        }
    }
    return latest ? { tag: latest.tag, version: latest.version } : null;
}

function normalizeCommitMessage(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    if (!lines.length) {
        return '';
    }

    let start = 0;
    let end = lines.length;

    while (start < end && lines[start].trim() === '') {
        start += 1;
    }
    while (end > start && lines[end - 1].trim() === '') {
        end -= 1;
    }

    if (start < end && lines[start].trim().startsWith('```')) {
        start += 1;
        while (start < end && lines[start].trim() === '') {
            start += 1;
        }
        if (end > start && lines[end - 1].trim() === '```') {
            end -= 1;
        }
    }

    while (start < end && lines[start].trim() === '') {
        start += 1;
    }
    while (end > start && lines[end - 1].trim() === '') {
        end -= 1;
    }

    return lines.slice(start, end).join('\n').trim();
}

function extractAgentMessageFromCodexJsonl(text) {
    let lastMessage = '';
    for (const rawLine of String(text || '').split('\n')) {
        const line = rawLine.trim();
        if (!line) {
            continue;
        }
        let payload;
        try {
            payload = JSON.parse(line);
        } catch (error) {
            continue;
        }
        if (payload && payload.type === 'item.completed' && payload.item && payload.item.type === 'agent_message') {
            lastMessage = String(payload.item.text || '');
        }
    }
    return lastMessage.trim();
}

module.exports = {
    parseReleaseVersion,
    compareReleaseVersions,
    buildVersionSuggestions,
    pickLatestVersionTag,
    normalizeCommitMessage,
    extractAgentMessageFromCodexJsonl
};
