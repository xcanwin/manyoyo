'use strict';

function getSessionRef(ctx, res, sessionName, dependencies) {
    return dependencies.getValidSessionRef(ctx, res, sessionName);
}

async function handleSessionFileListRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = getSessionRef(ctx, res, sessionName, dependencies);
    if (!sessionRef) return;
    const requestUrl = new URL(req.url || '/api/sessions/x/fs/list', 'http://localhost');
    const targetPath = String(requestUrl.searchParams.get('path') || '/').trim() || '/';
    await dependencies.ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
    const payload = await dependencies.execJsonCommandInWebContainer(
        ctx,
        sessionRef.containerName,
        dependencies.buildContainerFileListCommand(targetPath)
    );
    if (payload && payload.error) {
        dependencies.sendJson(res, 400, { error: payload.error });
        return;
    }
    dependencies.sendJson(res, 200, payload);
}

async function handleSessionFileReadRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = getSessionRef(ctx, res, sessionName, dependencies);
    if (!sessionRef) return;
    const requestUrl = new URL(req.url || '/api/sessions/x/fs/read', 'http://localhost');
    const targetPath = String(requestUrl.searchParams.get('path') || '').trim();
    const fullRequested = ['1', 'true', 'yes'].includes(String(requestUrl.searchParams.get('full') || '').toLowerCase());
    if (!targetPath) {
        dependencies.sendJson(res, 400, { error: 'path 不能为空' });
        return;
    }
    await dependencies.ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
    const payload = await dependencies.execJsonCommandInWebContainer(
        ctx,
        sessionRef.containerName,
        dependencies.buildContainerFileReadCommand(targetPath, {
            maxBytes: fullRequested ? 0 : dependencies.filePreviewMaxBytes
        })
    );
    if (payload && payload.error) {
        dependencies.sendJson(res, 400, { error: payload.error });
        return;
    }
    if (payload && payload.kind === 'text') {
        payload.language = dependencies.inferFileLanguage(payload.path);
        payload.editable = payload.truncated !== true && Number(payload.size || 0) < dependencies.fileEditMaxBytes;
    }
    dependencies.sendJson(res, 200, payload);
}

async function handleSessionFileWriteRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = getSessionRef(ctx, res, sessionName, dependencies);
    if (!sessionRef) return;
    const payload = await dependencies.readJsonBody(req);
    const targetPath = String(payload && payload.path ? payload.path : '').trim();
    const content = typeof payload.content === 'string' ? payload.content : null;
    const expectedRevision = typeof payload.expectedRevision === 'string' ? payload.expectedRevision : '';
    if (!targetPath) {
        dependencies.sendJson(res, 400, { error: 'path 不能为空' });
        return;
    }
    if (content === null) {
        dependencies.sendJson(res, 400, { error: 'content 必须是字符串' });
        return;
    }
    if (expectedRevision && !/^[a-f0-9]{64}$/i.test(expectedRevision)) {
        dependencies.sendJson(res, 400, { error: 'expectedRevision 格式错误' });
        return;
    }
    if (Buffer.byteLength(content, 'utf8') >= dependencies.fileEditMaxBytes) {
        dependencies.sendJson(res, 400, { error: '文件过大，当前仅支持编辑小于 2MB 的文本文件' });
        return;
    }
    await dependencies.ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
    const result = await dependencies.execJsonCommandInWebContainer(
        ctx,
        sessionRef.containerName,
        dependencies.buildContainerFileWriteCommand(targetPath, content, expectedRevision)
    );
    if (result && result.conflict === true) {
        dependencies.sendJson(res, 409, {
            conflict: true,
            message: result.error || '文件已被外部修改，请重新加载后再保存',
            currentRevision: result.currentRevision || ''
        });
        return;
    }
    if (result && result.error) {
        dependencies.sendJson(res, 400, { error: result.error });
        return;
    }
    dependencies.sendJson(res, 200, result);
}

async function handleSessionFileMkdirRequest(req, res, ctx, state, sessionName, dependencies) {
    const sessionRef = getSessionRef(ctx, res, sessionName, dependencies);
    if (!sessionRef) return;
    const payload = await dependencies.readJsonBody(req);
    const targetPath = String(payload && payload.path ? payload.path : '').trim();
    if (!targetPath) {
        dependencies.sendJson(res, 400, { error: 'path 不能为空' });
        return;
    }
    await dependencies.ensureWebContainer(ctx, state, sessionRef.containerName, sessionRef);
    const result = await dependencies.execJsonCommandInWebContainer(
        ctx,
        sessionRef.containerName,
        dependencies.buildContainerFileMkdirCommand(targetPath)
    );
    if (result && result.error) {
        dependencies.sendJson(res, 400, { error: result.error });
        return;
    }
    dependencies.sendJson(res, 200, result);
}

module.exports = {
    handleSessionFileListRequest,
    handleSessionFileReadRequest,
    handleSessionFileWriteRequest,
    handleSessionFileMkdirRequest
};
