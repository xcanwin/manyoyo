import { basicSetup } from 'codemirror';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';

function resolveLanguageExtension(language) {
    switch (String(language || '').trim()) {
    case 'css':
        return css();
    case 'html':
        return html();
    case 'javascript':
        return javascript({ jsx: true, typescript: true });
    case 'json':
        return json();
    case 'markdown':
        return markdown();
    case 'python':
        return python();
    case 'yaml':
        return yaml();
    default:
        return [];
    }
}

function createEditor(parent, options = {}) {
    const target = parent;
    const initialDoc = String(options.doc || '');
    const initialLanguage = String(options.language || 'text').trim();
    const initialReadOnly = options.readOnly !== false;
    const languageCompartment = new Compartment();
    const readOnlyCompartment = new Compartment();
    const view = new EditorView({
        parent: target,
        state: EditorState.create({
            doc: initialDoc,
            extensions: [
                basicSetup,
                EditorView.lineWrapping,
                readOnlyCompartment.of([
                    EditorState.readOnly.of(initialReadOnly),
                    EditorView.editable.of(!initialReadOnly)
                ]),
                languageCompartment.of(resolveLanguageExtension(initialLanguage)),
                EditorView.theme({
                    '&': {
                        height: '100%',
                        fontSize: '12px'
                    },
                    '.cm-scroller': {
                        overflow: 'auto'
                    }
                })
            ]
        })
    });

    return {
        setValue(nextValue) {
            const text = String(nextValue == null ? '' : nextValue);
            view.dispatch({
                changes: {
                    from: 0,
                    to: view.state.doc.length,
                    insert: text
                }
            });
        },
        setLanguage(nextLanguage) {
            view.dispatch({
                effects: languageCompartment.reconfigure(resolveLanguageExtension(nextLanguage))
            });
        },
        setReadOnly(readOnly) {
            const value = readOnly !== false;
            view.dispatch({
                effects: readOnlyCompartment.reconfigure([
                    EditorState.readOnly.of(value),
                    EditorView.editable.of(!value)
                ])
            });
        },
        destroy() {
            view.destroy();
        }
    };
}

window.ManyoyoCodeEditor = {
    create: createEditor
};
