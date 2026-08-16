'use strict';

const SCENE_ORDER = ['mcp-cont-headless', 'mcp-cont-headed', 'mcp-host-headless', 'mcp-host-headed', 'cli-host-headless', 'cli-host-headed', 'dev-host-headed'];

const SCENE_DEFS = {
    'mcp-cont-headless': {
        type: 'container',
        engine: 'mcp',
        configFile: 'mcp-cont-headless.json',
        composeFile: 'compose-headless.yaml',
        projectName: 'my-playwright-mcp-cont-headless',
        containerName: 'my-playwright-mcp-cont-headless',
        portKey: 'mcpContHeadless',
        headless: true,
        listenHost: '0.0.0.0'
    },
    'mcp-cont-headed': {
        type: 'container',
        engine: 'mcp',
        configFile: 'mcp-cont-headed.json',
        composeFile: 'compose-headed.yaml',
        projectName: 'my-playwright-mcp-cont-headed',
        containerName: 'my-playwright-mcp-cont-headed',
        portKey: 'mcpContHeaded',
        headless: false,
        listenHost: '0.0.0.0'
    },
    'mcp-host-headless': {
        type: 'host',
        engine: 'mcp',
        configFile: 'mcp-host-headless.json',
        portKey: 'mcpHostHeadless',
        headless: true,
        listenHost: '127.0.0.1'
    },
    'mcp-host-headed': {
        type: 'host',
        engine: 'mcp',
        configFile: 'mcp-host-headed.json',
        portKey: 'mcpHostHeaded',
        headless: false,
        listenHost: '127.0.0.1'
    },
    'cli-host-headless': {
        type: 'host',
        engine: 'cli',
        configFile: 'cli-host-headless.json',
        portKey: 'cliHostHeadless',
        headless: true,
        listenHost: '0.0.0.0'
    },
    'cli-host-headed': {
        type: 'host',
        engine: 'cli',
        configFile: 'cli-host-headed.json',
        portKey: 'cliHostHeaded',
        headless: false,
        listenHost: '0.0.0.0'
    },
    'dev-host-headed': {
        type: 'host',
        engine: 'dev',
        configFile: 'dev-host-headed.json',
        headless: false
    }
};

function isMcpScene(sceneName) {
    return Boolean(SCENE_DEFS[sceneName] && SCENE_DEFS[sceneName].engine === 'mcp');
}

function isCliScene(sceneName) {
    return Boolean(SCENE_DEFS[sceneName] && SCENE_DEFS[sceneName].engine === 'cli');
}

function isDevScene(sceneName) {
    return Boolean(SCENE_DEFS[sceneName] && SCENE_DEFS[sceneName].engine === 'dev');
}

function isCliSessionScene(sceneName) {
    return isCliScene(sceneName) || isDevScene(sceneName);
}

module.exports = {
    SCENE_ORDER,
    SCENE_DEFS,
    isMcpScene,
    isCliScene,
    isDevScene,
    isCliSessionScene
};
