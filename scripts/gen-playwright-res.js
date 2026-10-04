#!/usr/bin/env node
'use strict';

// 由 lib/plugin/fingerprint.js 生成镜像内的默认 Playwright 配置：docker/res/playwright/{browser.json,stealth.init.js}
const fs = require('fs');
const path = require('path');
const { buildContainerConfig, buildInitScript } = require('../lib/plugin/fingerprint');

function renderDefaultFiles() {
    return {
        'browser.json': `${JSON.stringify(buildContainerConfig('default'), null, 4)}\n`,
        'stealth.init.js': buildInitScript()
    };
}

if (require.main === module) {
    const dir = path.join(__dirname, '..', 'docker', 'res', 'playwright');
    for (const [name, content] of Object.entries(renderDefaultFiles())) {
        fs.writeFileSync(path.join(dir, name), content, 'utf8');
    }
}

module.exports = { renderDefaultFiles };
