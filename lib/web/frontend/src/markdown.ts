import { marked, type Tokens } from 'marked';

function escapeAttribute(value: string) {
    return String(value || '').replace(/[&<>'"]/g, character => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[character] || character));
}

function isSafeHref(value: string) {
    const href = String(value || '').trim();
    if (!href) return false;
    if (/^(https?:|mailto:)/i.test(href)) return true;
    return href.startsWith('/') || href.startsWith('#') || href.startsWith('./') || href.startsWith('../');
}

export function renderSafeMarkdown(value: string) {
    const renderer = new marked.Renderer();
    renderer.html = () => '';
    renderer.image = () => '';
    renderer.link = ({ href, title, tokens }: Tokens.Link) => {
        const text = renderer.parser.parseInline(tokens);
        if (!isSafeHref(href)) return text;
        const titleAttribute = title ? ` title="${escapeAttribute(title)}"` : '';
        return `<a href="${escapeAttribute(href)}" target="_blank" rel="noopener noreferrer"${titleAttribute}>${text}</a>`;
    };
    return String(marked.parse(String(value || ''), {
        async: false,
        breaks: true,
        gfm: true,
        renderer
    }));
}
