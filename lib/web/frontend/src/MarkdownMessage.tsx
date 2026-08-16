import { renderSafeMarkdown } from './markdown';

export function MarkdownMessage({ value, className = '' }: { value: string; className?: string }) {
    return <article className={`markdown-message ${className}`.trim()} dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(value) }} />;
}
