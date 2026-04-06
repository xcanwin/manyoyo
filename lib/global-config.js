'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSON5 = require('json5');
const { findTopLevelPropertyValueRange } = require('./json5-text-edit');

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

function insertTopLevelImageVersion(text, imageVersion) {
    const openBraceIndex = text.indexOf('{');
    if (openBraceIndex === -1) {
        return null;
    }

    const newlineIndex = text.indexOf('\n', openBraceIndex);
    const insertIndex = newlineIndex === -1 ? openBraceIndex + 1 : newlineIndex + 1;
    return `${text.slice(0, insertIndex)}    imageVersion: ${JSON.stringify(imageVersion)},\n${text.slice(insertIndex)}`;
}

function updateImageVersionText(text, imageVersion) {
    const range = findTopLevelPropertyValueRange(text, 'imageVersion');
    if (range) {
        return `${text.slice(0, range.start)}${JSON.stringify(imageVersion)}${text.slice(range.end)}`;
    }
    return insertTopLevelImageVersion(text, imageVersion);
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

    const nextConfig = {
        ...currentConfig,
        imageVersion
    };

    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    if (result.exists) {
        const currentText = fs.readFileSync(configPath, 'utf-8');
        const updatedText = updateImageVersionText(currentText, imageVersion);
        if (updatedText) {
            fs.writeFileSync(configPath, updatedText.endsWith('\n') ? updatedText : `${updatedText}\n`);
        } else {
            fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 4)}\n`);
        }
    } else {
        fs.writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 4)}\n`);
    }

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
