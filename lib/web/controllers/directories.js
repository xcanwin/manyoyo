'use strict';

async function handleDirectoryListRequest(req, res, dependencies) {
    const requestUrl = new URL(req.url || '/api/fs/directories', 'http://localhost');
    const requestedPath = dependencies.expandHomeAliasPath(String(requestUrl.searchParams.get('path') || '').trim() || dependencies.os.homedir());
    const requestedBasePath = dependencies.expandHomeAliasPath(String(requestUrl.searchParams.get('basePath') || '').trim());
    const realPath = dependencies.fs.realpathSync(requestedPath);
    if (!dependencies.fs.statSync(realPath).isDirectory()) {
        dependencies.sendJson(res, 400, { error: `目录不存在: ${realPath}` });
        return;
    }
    let realBasePath = '';
    if (requestedBasePath) {
        realBasePath = dependencies.fs.realpathSync(requestedBasePath);
        if (!dependencies.fs.statSync(realBasePath).isDirectory()) {
            dependencies.sendJson(res, 400, { error: `basePath 不是目录: ${realBasePath}` });
            return;
        }
        const relativeToBase = dependencies.path.relative(realBasePath, realPath);
        if (relativeToBase.startsWith('..') || dependencies.path.isAbsolute(relativeToBase)) {
            dependencies.sendJson(res, 400, { error: '目录超出 basePath 范围' });
            return;
        }
    }
    const parentPath = realBasePath ? (realPath === realBasePath ? '' : dependencies.path.dirname(realPath)) : (realPath === dependencies.path.parse(realPath).root ? '' : dependencies.path.dirname(realPath));
    const entries = dependencies.fs.readdirSync(realPath, { withFileTypes: true }).filter(entry => entry && entry.isDirectory()).map(entry => ({ name: entry.name, path: dependencies.path.join(realPath, entry.name) })).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    dependencies.sendJson(res, 200, { currentPath: realPath, basePath: realBasePath || '', parentPath, entries });
}

async function handleDirectoryMkdirRequest(req, res, dependencies) {
    const payload = await dependencies.readJsonBody(req);
    const requestedPath = dependencies.expandHomeAliasPath(String(payload && payload.path ? payload.path : '').trim());
    if (!requestedPath) { dependencies.sendJson(res, 400, { error: 'path 不能为空' }); return; }
    const targetPath = dependencies.path.resolve(requestedPath);
    dependencies.fs.mkdirSync(targetPath, { recursive: true });
    dependencies.sendJson(res, 200, { path: targetPath, created: true });
}

module.exports = { handleDirectoryListRequest, handleDirectoryMkdirRequest };
