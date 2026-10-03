'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSON5 = require('json5');
const { upsertValueByPath } = require('./json5-text-edit');
const { writeConfigFileSecure } = require('./secure-file');

function getManyoyoConfigPath(homeDir = os.homedir()) {
    return path.join(homeDir, '.manyoyo', 'manyoyo.json');
}

function readManyoyoConfig(homeDir = os.homedir()) {
    const configPath = getManyoyoConfigPath(homeDir);
    if (!fs.existsSync(configPath)) {
        return {
            path: configPath,
            exists: false,
            config: {}
        };
    }

    try {
        const config = JSON5.parse(fs.readFileSync(configPath, 'utf-8'));
        return {
            path: configPath,
            exists: true,
            config
        };
    } catch (error) {
        return {
            path: configPath,
            exists: true,
            config: {},
            parseError: error
        };
    }
}

function updateImageVersionText(text, imageVersion) {
    return upsertValueByPath(text, ['imageVersion'], JSON.stringify(imageVersion));
}

function syncGlobalImageVersion(imageVersion, options = {}) {
    const homeDir = options.homeDir || os.homedir();
    const result = readManyoyoConfig(homeDir);
    const configPath = result.path;

    if (result.parseError) {
        return {
            updated: false,
            path: configPath,
            reason: 'parse-error'
        };
    }

    const currentConfig = result.config;
    if (typeof currentConfig !== 'object' || currentConfig === null || Array.isArray(currentConfig)) {
        return {
            updated: false,
            path: configPath,
            reason: 'invalid-root'
        };
    }

    if (currentConfig.imageVersion === imageVersion) {
        return {
            updated: false,
            path: configPath,
            reason: 'unchanged'
        };
    }

    // 只在原文上局部替换，保留注释与格式；文件不存在或为空时写标准 JSON
    const currentText = result.exists ? fs.readFileSync(configPath, 'utf-8') : '';
    const updatedText = currentText.trim()
        ? updateImageVersionText(currentText, imageVersion)
        : `${JSON.stringify({ imageVersion }, null, 4)}\n`;
    writeConfigFileSecure(configPath, updatedText.endsWith('\n') ? updatedText : `${updatedText}\n`);

    return {
        updated: true,
        path: configPath,
        reason: result.exists ? 'updated' : 'created'
    };
}

module.exports = {
    getManyoyoConfigPath,
    readManyoyoConfig,
    syncGlobalImageVersion
};
