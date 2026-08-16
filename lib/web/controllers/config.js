'use strict';

async function handleWebConfigReadRequest(res, ctx, state, dependencies) {
    const snapshot = dependencies.readWebConfigSnapshot(state.webConfigPath);
    dependencies.sendJson(res, 200, dependencies.buildSafeWebConfigSnapshot(snapshot, ctx));
}

async function handleWebConfigWriteRequest(req, res, ctx, state, dependencies) {
    const payload = await dependencies.readJsonBody(req);
    const raw = typeof payload.raw === 'string' ? payload.raw : '';
    if (!raw.trim()) {
        dependencies.sendJson(res, 400, { error: '配置内容不能为空' });
        return;
    }

    const currentSnapshot = dependencies.readWebConfigSnapshot(state.webConfigPath);
    let finalRaw = raw;
    let parsed = null;
    try {
        finalRaw = dependencies.restoreWebConfigSecrets(raw, currentSnapshot);
        parsed = dependencies.parseAndValidateConfigRaw(finalRaw);
    } catch (error) {
        dependencies.sendJson(res, 400, { error: '配置格式错误', detail: error.message || '解析失败' });
        return;
    }

    const savePath = dependencies.path.resolve(state.webConfigPath);
    dependencies.fs.mkdirSync(dependencies.path.dirname(savePath), { recursive: true });
    dependencies.fs.writeFileSync(savePath, finalRaw, 'utf-8');
    dependencies.sendJson(res, 200, {
        saved: true,
        path: savePath,
        defaults: dependencies.buildConfigDefaults(ctx, parsed)
    });
}

module.exports = { handleWebConfigReadRequest, handleWebConfigWriteRequest };
