'use strict';

const { SCENE_DEFS, SCENE_ORDER } = require('./playwright-scenes');

function resolveSceneTargets(sceneName = 'all', config = {}) {
    const requested = String(sceneName || 'all').trim();
    const enabledSet = new Set(Array.isArray(config.enabledScenes) ? config.enabledScenes : []);
    const runtime = String(config.runtime || 'mixed').trim();
    const isAllowedByRuntime = scene => runtime === 'mixed' || runtime === SCENE_DEFS[scene].type;

    if (requested !== 'all') {
        if (!SCENE_DEFS[requested]) {
            throw new Error(`未知场景: ${requested}`);
        }
        if (!enabledSet.has(requested)) {
            throw new Error(`场景未启用: ${requested}`);
        }
        if (!isAllowedByRuntime(requested)) {
            throw new Error(`当前 runtime=${runtime}，不允许场景: ${requested}`);
        }
        return [requested];
    }

    return SCENE_ORDER
        .filter(scene => enabledSet.has(scene))
        .filter(isAllowedByRuntime);
}

module.exports = { resolveSceneTargets };
