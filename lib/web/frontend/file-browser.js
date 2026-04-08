(function () {
    const FILE_EDIT_MAX_BYTES = 2 * 1024 * 1024;
    function escapeHtml(value) {
        return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function formatBytes(size) {
        const value = Number(size || 0);
        if (!Number.isFinite(value) || value <= 0) {
            return '0 B';
        }
        if (value < 1024) {
            return `${value} B`;
        }
        if (value < 1024 * 1024) {
            return `${(value / 1024).toFixed(1)} KB`;
        }
        if (value < 1024 * 1024 * 1024) {
            return `${(value / (1024 * 1024)).toFixed(1)} MB`;
        }
        return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }

    function formatDateTime(value) {
        if (!value) {
            return '未知时间';
        }
        const date = new Date(value);
        if (Number.isNaN(date.getTime())) {
            return '未知时间';
        }
        return date.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit'
        });
    }

    function buildEntryMeta(entry) {
        const parts = [];
        if (entry && entry.kind === 'directory') {
            parts.push('目录');
        } else {
            parts.push(formatBytes(entry && entry.size));
        }
        if (entry && entry.mtimeMs) {
            parts.push(formatDateTime(entry.mtimeMs));
        }
        return parts.join(' · ');
    }

    function inferLanguageFromPath(filePath) {
        const text = String(filePath || '').toLowerCase();
        if (text.endsWith('.md') || text.endsWith('.markdown')) return 'markdown';
        if (text.endsWith('.json')) return 'json';
        if (text.endsWith('.py')) return 'python';
        if (text.endsWith('.yaml') || text.endsWith('.yml')) return 'yaml';
        if (text.endsWith('.html') || text.endsWith('.htm')) return 'html';
        if (text.endsWith('.css')) return 'css';
        if (text.endsWith('.js') || text.endsWith('.jsx') || text.endsWith('.mjs') || text.endsWith('.cjs') || text.endsWith('.ts') || text.endsWith('.tsx')) {
            return 'javascript';
        }
        return 'text';
    }

    function create(options) {
        const root = options && options.root;
        const api = options && options.api;
        const onError = options && typeof options.onError === 'function'
            ? options.onError
            : function (message) { window.alert(message); };
        if (!root || typeof api !== 'function') {
            return {
                sync: function () {}
            };
        }

        root.innerHTML = `
            <section class="files-browser">
                <header class="files-toolbar">
                    <button type="button" class="secondary" data-action="up">上一级</button>
                    <div class="files-toolbar-path-group">
                        <input type="text" class="files-toolbar-path-input" data-role="path" value="/" spellcheck="false" />
                        <button type="button" class="secondary" data-action="visit">访问</button>
                    </div>
                    <div class="files-toolbar-status" data-role="status">未加载</div>
                </header>
                <div class="files-layout">
                    <aside class="files-sidebar">
                        <div class="files-list" data-role="list"></div>
                    </aside>
                    <section class="files-preview">
                        <header class="files-preview-head">
                            <div class="files-preview-head-main">
                                <div class="files-preview-title" data-role="preview-title">未选择文件</div>
                                <div class="files-preview-meta" data-role="preview-meta">请选择左侧文件或目录</div>
                            </div>
                            <div class="files-preview-actions">
                                <button type="button" class="secondary" data-action="save" disabled>保存</button>
                            </div>
                        </header>
                        <div class="files-preview-body" data-role="preview-body"></div>
                    </section>
                </div>
            </section>
        `;

        const pathNode = root.querySelector('[data-role="path"]');
        const statusNode = root.querySelector('[data-role="status"]');
        const listNode = root.querySelector('[data-role="list"]');
        const previewTitleNode = root.querySelector('[data-role="preview-title"]');
        const previewMetaNode = root.querySelector('[data-role="preview-meta"]');
        const previewBodyNode = root.querySelector('[data-role="preview-body"]');
        const upBtn = root.querySelector('[data-action="up"]');
        const visitBtn = root.querySelector('[data-action="visit"]');
        const saveBtn = root.querySelector('[data-action="save"]');

        const state = {
            visible: false,
            sessionName: '',
            containerName: '',
            containerPath: '',
            historyOnly: false,
            currentPath: '',
            pathDraft: '',
            parentPath: '',
            entries: [],
            selectedPath: '',
            selectedFile: null,
            selectedEntry: null,
            loadingList: false,
            loadingFile: false,
            savingFile: false,
            listRequestId: 0,
            readRequestId: 0,
            editor: null,
            editorHost: null,
            previewReadOnly: true,
            previewDirty: false
        };

        function setStatus(text) {
            if (statusNode) {
                statusNode.textContent = String(text || '').trim() || '就绪';
            }
        }

        function destroyEditor() {
            if (state.editor && typeof state.editor.destroy === 'function') {
                state.editor.destroy();
            }
            state.editor = null;
            state.editorHost = null;
        }

        function isEditablePreview() {
            return Boolean(
                state.selectedFile
                && state.selectedFile.kind === 'text'
                && state.previewReadOnly === false
                && state.historyOnly !== true
                && state.savingFile !== true
            );
        }

        function syncSaveButton() {
            if (!saveBtn) {
                return;
            }
            saveBtn.disabled = !isEditablePreview();
            saveBtn.textContent = state.savingFile ? '保存中...' : '保存';
        }

        function renderPreviewEmpty(title, description) {
            state.selectedFile = null;
            state.previewReadOnly = true;
            state.previewDirty = false;
            if (previewTitleNode) {
                previewTitleNode.textContent = title;
            }
            if (previewMetaNode) {
                previewMetaNode.textContent = description;
            }
            if (previewBodyNode) {
                previewBodyNode.innerHTML = `<div class="files-empty">${escapeHtml(description)}</div>`;
            }
            destroyEditor();
            syncSaveButton();
        }

        function ensureEditorHost() {
            if (!previewBodyNode) {
                return null;
            }
            previewBodyNode.innerHTML = '';
            const host = document.createElement('div');
            host.className = 'files-editor-host';
            previewBodyNode.appendChild(host);
            state.editorHost = host;
            return host;
        }

        function renderPreviewPayload(payload) {
            state.selectedFile = payload || null;
            state.previewReadOnly = !(payload && payload.editable === true);
            state.previewDirty = false;
            if (!payload) {
                renderPreviewEmpty('未选择文件', '请选择左侧文件进行预览。');
                return;
            }
            if (previewTitleNode) {
                previewTitleNode.textContent = payload.path || '未命名文件';
            }
            if (previewMetaNode) {
                const modeLabel = payload.kind === 'text'
                    ? (payload.editable === true ? '可编辑' : '只读预览')
                    : '只读预览';
                previewMetaNode.textContent = `${payload.kind === 'text' ? '文本文件' : '文件'} · ${formatBytes(payload.size)} · ${modeLabel}${payload.truncated ? ' · 已截断预览' : ''}`;
            }
            if (!previewBodyNode) {
                syncSaveButton();
                return;
            }

            if (payload.kind === 'text') {
                const language = payload.language || inferLanguageFromPath(payload.path);
                if (window.ManyoyoCodeEditor && typeof window.ManyoyoCodeEditor.create === 'function') {
                    if (!state.editor || !state.editorHost || !previewBodyNode.contains(state.editorHost)) {
                        destroyEditor();
                        const host = ensureEditorHost();
                        if (host) {
                            state.editor = window.ManyoyoCodeEditor.create(host, {
                                doc: String(payload.content || ''),
                                language,
                                readOnly: state.previewReadOnly,
                                onChange: function () {
                                    state.previewDirty = true;
                                    syncSaveButton();
                                }
                            });
                        }
                    } else {
                        state.editor.setValue(String(payload.content || ''));
                        state.editor.setLanguage(language);
                        state.editor.setReadOnly(state.previewReadOnly);
                    }
                    syncSaveButton();
                    return;
                }

                destroyEditor();
                previewBodyNode.innerHTML = `<pre class="files-pre">${escapeHtml(String(payload.content || ''))}</pre>`;
                syncSaveButton();
                return;
            }

            destroyEditor();
            previewBodyNode.innerHTML = `<div class="files-note">当前文件暂不支持在线预览。文件类型：${escapeHtml(payload.kind || 'unknown')}</div>`;
            syncSaveButton();
        }

        function renderList() {
            if (pathNode) {
                pathNode.value = state.pathDraft || state.currentPath || state.containerPath || '/';
            }
            if (upBtn) {
                upBtn.disabled = state.loadingList || !state.parentPath;
            }
            if (visitBtn) {
                visitBtn.disabled = state.loadingList || state.loadingFile || !(state.pathDraft || '').trim();
            }
            if (!listNode) {
                return;
            }
            listNode.innerHTML = '';

            if (!state.sessionName) {
                listNode.innerHTML = '<div class="files-empty">请选择左侧会话后再浏览容器文件。</div>';
                renderPreviewEmpty('未选择会话', '请选择左侧会话后再浏览容器文件。');
                setStatus('未选择会话');
                return;
            }
            if (state.historyOnly) {
                listNode.innerHTML = '<div class="files-empty">当前会话只有历史记录，没有可访问的运行中容器。</div>';
                renderPreviewEmpty('容器不可用', '当前会话只有历史记录，没有可访问的运行中容器。');
                setStatus('容器不可用');
                return;
            }
            if (state.loadingList) {
                listNode.innerHTML = '<div class="files-empty">正在读取目录...</div>';
                setStatus('读取目录中');
                return;
            }
            if (!state.entries.length) {
                listNode.innerHTML = '<div class="files-empty">当前目录为空。</div>';
                setStatus('目录为空');
                return;
            }

            state.entries.forEach(function (entry) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'files-entry' + (state.selectedPath === entry.path ? ' is-active' : '');
                button.title = String(entry.path || entry.name || '');
                button.addEventListener('click', function () {
                    if (entry.kind === 'directory') {
                        loadDirectory(entry.path);
                        return;
                    }
                    loadFile(entry.path, entry);
                });
                button.innerHTML = `
                    <span class="files-entry-name">
                        <span class="files-entry-title">${escapeHtml(entry.name || entry.path || '未命名')}</span>
                    </span>
                    <span class="files-entry-meta">${escapeHtml(buildEntryMeta(entry))}</span>
                `;
                listNode.appendChild(button);
            });
            setStatus(state.loadingFile ? '读取文件中' : `共 ${state.entries.length} 项`);
        }

        async function loadDirectory(targetPath) {
            const pathText = String(targetPath || state.currentPath || state.containerPath || '/').trim() || '/';
            const requestId = state.listRequestId + 1;
            state.listRequestId = requestId;
            state.loadingList = true;
            state.pathDraft = pathText;
            state.selectedPath = '';
            state.selectedEntry = null;
            renderList();
            try {
                const payload = await api('/api/sessions/' + encodeURIComponent(state.sessionName) + '/fs/list?path=' + encodeURIComponent(pathText));
                if (requestId !== state.listRequestId) {
                    return;
                }
                state.currentPath = payload && payload.path ? payload.path : pathText;
                state.pathDraft = state.currentPath;
                state.parentPath = payload && payload.parentPath ? payload.parentPath : '';
                state.entries = Array.isArray(payload && payload.entries) ? payload.entries : [];
                renderPreviewEmpty('未选择文件', '请选择左侧文件进行预览。');
            } catch (e) {
                if (requestId !== state.listRequestId) {
                    return;
                }
                onError(e && e.message ? e.message : '读取目录失败');
            } finally {
                if (requestId !== state.listRequestId) {
                    return;
                }
                state.loadingList = false;
                renderList();
            }
        }

        async function loadFile(targetPath, entry) {
            const pathText = String(targetPath || '').trim();
            if (!pathText) {
                return;
            }
            const selectedEntry = entry && typeof entry === 'object' ? entry : null;
            const fileSize = Number(selectedEntry && selectedEntry.size);
            const requiresReadonlyConfirm = Number.isFinite(fileSize) && fileSize >= FILE_EDIT_MAX_BYTES;
            if (requiresReadonlyConfirm) {
                const yes = window.confirm(`文件较大（${formatBytes(fileSize)}），继续后将以只读方式全量预览，无法保存。是否继续？`);
                if (!yes) {
                    return;
                }
            }
            const requestId = state.readRequestId + 1;
            state.readRequestId = requestId;
            state.loadingFile = true;
            state.selectedPath = pathText;
            state.selectedEntry = selectedEntry;
            renderList();
            renderPreviewEmpty(pathText, '正在读取文件内容...');
            try {
                const payload = await api(
                    '/api/sessions/' + encodeURIComponent(state.sessionName) + '/fs/read?path='
                    + encodeURIComponent(pathText)
                    + '&full=1'
                );
                if (requestId !== state.readRequestId) {
                    return;
                }
                if (requiresReadonlyConfirm && payload && payload.kind === 'text') {
                    payload.editable = false;
                }
                renderPreviewPayload(payload);
            } catch (e) {
                if (requestId !== state.readRequestId) {
                    return;
                }
                renderPreviewEmpty(pathText, e && e.message ? e.message : '读取文件失败');
                onError(e && e.message ? e.message : '读取文件失败');
            } finally {
                if (requestId !== state.readRequestId) {
                    return;
                }
                state.loadingFile = false;
                renderList();
            }
        }

        async function saveCurrentFile() {
            if (!isEditablePreview() || !state.editor || typeof state.editor.getValue !== 'function' || !state.selectedFile || !state.selectedFile.path) {
                return;
            }
            state.savingFile = true;
            syncSaveButton();
            setStatus('保存中');
            try {
                const nextContent = state.editor.getValue();
                const payload = await api('/api/sessions/' + encodeURIComponent(state.sessionName) + '/fs/write', {
                    method: 'PUT',
                    body: JSON.stringify({
                        path: state.selectedFile.path,
                        content: nextContent
                    })
                });
                state.previewDirty = false;
                if (state.selectedFile) {
                    state.selectedFile.content = nextContent;
                    state.selectedFile.size = payload && typeof payload.size === 'number'
                        ? payload.size
                        : new TextEncoder().encode(nextContent).length;
                }
                const matchedEntry = state.entries.find(function (item) {
                    return item && state.selectedFile && item.path === state.selectedFile.path;
                });
                if (matchedEntry && state.selectedFile) {
                    matchedEntry.size = state.selectedFile.size;
                }
                renderPreviewPayload(state.selectedFile);
                renderList();
                setStatus('已保存');
            } catch (e) {
                setStatus('保存失败');
                onError(e && e.message ? e.message : '保存文件失败');
            } finally {
                state.savingFile = false;
                syncSaveButton();
            }
        }

        function sync(context) {
            const session = context && context.session;
            const detail = context && context.detail;
            const nextSessionName = String(session && session.name ? session.name : '').trim();
            const nextContainerName = String(session && session.containerName ? session.containerName : '').trim();
            const nextContainerPath = String(
                (detail && detail.containerPath)
                || (session && session.containerPath)
                || '/'
            ).trim() || '/';
            const nextVisible = Boolean(context && context.visible);
            const nextHistoryOnly = context && context.historyOnly === true;
            const sessionChanged = nextSessionName !== state.sessionName;
            const containerPathChanged = nextContainerPath !== state.containerPath;

            state.visible = nextVisible;
            state.historyOnly = nextHistoryOnly;

            if (sessionChanged) {
                state.sessionName = nextSessionName;
                state.containerName = nextContainerName;
                state.containerPath = nextContainerPath;
                state.currentPath = '';
                state.pathDraft = nextContainerPath;
                state.parentPath = '';
                state.entries = [];
                state.selectedPath = '';
                state.selectedEntry = null;
                renderPreviewEmpty('未选择文件', '请选择左侧文件进行预览。');
            } else if (containerPathChanged) {
                state.containerPath = nextContainerPath;
                if (!state.currentPath) {
                    state.pathDraft = nextContainerPath;
                }
            }

            renderList();
            if (!nextVisible || !state.sessionName || state.historyOnly) {
                return;
            }
            if (sessionChanged || containerPathChanged || !state.currentPath) {
                loadDirectory(state.containerPath || '/');
            }
        }

        if (upBtn) {
            upBtn.addEventListener('click', function () {
                if (state.parentPath) {
                    loadDirectory(state.parentPath);
                }
            });
        }

        if (pathNode) {
            pathNode.addEventListener('input', function () {
                state.pathDraft = pathNode.value;
                renderList();
            });
            pathNode.addEventListener('keydown', function (event) {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    loadDirectory(pathNode.value);
                }
            });
        }

        if (visitBtn) {
            visitBtn.addEventListener('click', function () {
                loadDirectory(state.pathDraft || state.currentPath || state.containerPath || '/');
            });
        }

        if (saveBtn) {
            saveBtn.addEventListener('click', function () {
                saveCurrentFile().catch(function (e) {
                    onError(e && e.message ? e.message : '保存文件失败');
                });
            });
        }

        renderList();

        return {
            sync
        };
    }

    window.ManyoyoFileBrowser = {
        create
    };
}());
