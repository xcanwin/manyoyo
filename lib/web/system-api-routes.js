'use strict';

function createSystemApiRoutes(deps) {
    const {
        req,
        res,
        ctx,
        state,
        fs,
        os,
        path,
        withJsonBody,
        sendJson,
        expandHomeAliasPath,
        readWebConfigSnapshot,
        buildSafeWebConfigSnapshot,
        restoreWebConfigSecrets,
        parseAndValidateConfigRaw,
        buildConfigDefaults
    } = deps;

    return [
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/fs/directories' ? [] : null,
            handler: async () => {
                const requestUrl = new URL(req.url || '/api/fs/directories', 'http://localhost');
                const requestedPath = expandHomeAliasPath(String(requestUrl.searchParams.get('path') || '').trim() || os.homedir());
                const requestedBasePath = expandHomeAliasPath(String(requestUrl.searchParams.get('basePath') || '').trim());
                const realPath = fs.realpathSync(requestedPath);
                if (!fs.statSync(realPath).isDirectory()) {
                    sendJson(res, 400, { error: `目录不存在: ${realPath}` });
                    return;
                }

                let realBasePath = '';
                if (requestedBasePath) {
                    realBasePath = fs.realpathSync(requestedBasePath);
                    if (!fs.statSync(realBasePath).isDirectory()) {
                        sendJson(res, 400, { error: `basePath 不是目录: ${realBasePath}` });
                        return;
                    }
                    const relativeToBase = path.relative(realBasePath, realPath);
                    if (relativeToBase.startsWith('..') || path.isAbsolute(relativeToBase)) {
                        sendJson(res, 400, { error: '目录超出 basePath 范围' });
                        return;
                    }
                }

                const parentPath = realBasePath
                    ? (realPath === realBasePath ? '' : path.dirname(realPath))
                    : (realPath === path.parse(realPath).root ? '' : path.dirname(realPath));
                const entries = fs.readdirSync(realPath, { withFileTypes: true })
                    .filter(entry => entry && entry.isDirectory())
                    .map(entry => ({
                        name: entry.name,
                        path: path.join(realPath, entry.name)
                    }))
                    .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));

                sendJson(res, 200, {
                    currentPath: realPath,
                    basePath: realBasePath || '',
                    parentPath,
                    entries
                });
            }
        },
        {
            method: 'GET',
            match: currentPath => currentPath === '/api/config' ? [] : null,
            handler: async () => {
                const snapshot = readWebConfigSnapshot(state.webConfigPath);
                sendJson(res, 200, buildSafeWebConfigSnapshot(snapshot, ctx));
            }
        },
        {
            method: 'PUT',
            match: currentPath => currentPath === '/api/config' ? [] : null,
            handler: withJsonBody(async payload => {
                const raw = typeof payload.raw === 'string' ? payload.raw : '';
                if (!raw.trim()) {
                    sendJson(res, 400, { error: '配置内容不能为空' });
                    return;
                }

                const currentSnapshot = readWebConfigSnapshot(state.webConfigPath);
                let finalRaw = raw;
                let parsed = null;
                try {
                    finalRaw = restoreWebConfigSecrets(raw, currentSnapshot);
                    parsed = parseAndValidateConfigRaw(finalRaw);
                } catch (e) {
                    sendJson(res, 400, { error: '配置格式错误', detail: e.message || '解析失败' });
                    return;
                }

                const savePath = path.resolve(state.webConfigPath);
                fs.mkdirSync(path.dirname(savePath), { recursive: true });
                fs.writeFileSync(savePath, finalRaw, 'utf-8');

                sendJson(res, 200, {
                    saved: true,
                    path: savePath,
                    defaults: buildConfigDefaults(ctx, parsed)
                });
            })
        }
    ];
}

module.exports = {
    createSystemApiRoutes
};
