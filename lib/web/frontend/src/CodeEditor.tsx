import { useEffect, useRef } from 'react';
import { basicSetup } from 'codemirror';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';

type CodeEditorProps = {
    value: string;
    onChange: (value: string) => void;
    readOnly?: boolean;
    language?: string;
    ariaLabel: string;
};

function languageExtension(language: string) {
    switch (language) {
    case 'css': return css();
    case 'html': return html();
    case 'json': return json();
    case 'markdown': return markdown();
    case 'python': return python();
    case 'yaml': return yaml();
    case 'javascript': return javascript();
    default: return [];
    }
}

export function CodeEditor({ value, onChange, readOnly = false, language = 'text', ariaLabel }: CodeEditorProps) {
    const hostRef = useRef<HTMLDivElement | null>(null);
    const viewRef = useRef<EditorView | null>(null);
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;

    useEffect(() => {
        const host = hostRef.current;
        if (!host) return;
        const view = new EditorView({
            state: EditorState.create({
                doc: value,
                extensions: [
                    basicSetup,
                    keymap.of([...defaultKeymap, indentWithTab]),
                    EditorState.readOnly.of(readOnly),
                    EditorView.editable.of(!readOnly),
                    EditorView.contentAttributes.of({ 'aria-label': ariaLabel }),
                    EditorView.updateListener.of(update => {
                        if (update.docChanged) onChangeRef.current(update.state.doc.toString());
                    }),
                    languageExtension(language)
                ]
            }),
            parent: host
        });
        viewRef.current = view;
        return () => {
            view.destroy();
            if (viewRef.current === view) viewRef.current = null;
        };
    }, [ariaLabel, language, readOnly]);

    useEffect(() => {
        const view = viewRef.current;
        if (!view || view.state.doc.toString() === value) return;
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }, [value]);

    return <div className="code-editor" ref={hostRef} />;
}

export default CodeEditor;
