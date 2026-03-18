'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const JSON5 = require('json5');

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

function readQuotedString(text, startIndex) {
    const quote = text[startIndex];
    let value = '';

    for (let i = startIndex + 1; i < text.length; i += 1) {
        const ch = text[i];
        if (ch === '\\') {
            value += ch;
            if (i + 1 < text.length) {
                value += text[i + 1];
                i += 1;
            }
            continue;
        }
        if (ch === quote) {
            return {
                value,
                end: i + 1
            };
        }
        value += ch;
    }

    return null;
}

function isIdentifierStart(ch) {
    return /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch) {
    return /[A-Za-z0-9_$]/.test(ch);
}

function skipWhitespace(text, index) {
    let i = index;
    while (i < text.length && /\s/.test(text[i])) {
        i += 1;
    }
    return i;
}

function findTopLevelPropertyValueRange(text, propertyName) {
    let depth = 0;
    let inString = '';
    let inLineComment = false;
    let inBlockComment = false;

    for (let i = 0; i < text.length; i += 1) {
        const ch = text[i];
        const next = text[i + 1];

        if (inLineComment) {
            if (ch === '\n') inLineComment = false;
            continue;
        }
        if (inBlockComment) {
            if (ch === '*' && next === '/') {
                inBlockComment = false;
                i += 1;
            }
            continue;
        }
        if (inString) {
            if (ch === '\\') {
                i += 1;
                continue;
            }
            if (ch === inString) inString = '';
            continue;
        }

        if (ch === '/' && next === '/') {
            inLineComment = true;
            i += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlockComment = true;
            i += 1;
            continue;
        }
        if (depth === 1 && !/\s|,/.test(ch)) {
            let property = '';
            let cursor = i;
            if (ch === '"' || ch === '\'') {
                const token = readQuotedString(text, i);
                if (!token) {
                    return null;
                }
                property = token.value;
                cursor = token.end;
            } else if (isIdentifierStart(ch)) {
                cursor = i + 1;
                while (cursor < text.length && isIdentifierPart(text[cursor])) {
                    cursor += 1;
                }
                property = text.slice(i, cursor);
            }

            if (property) {
                const colonIndex = skipWhitespace(text, cursor);
                if (text[colonIndex] === ':') {
                    if (property !== propertyName) {
                        i = colonIndex;
                        continue;
                    }

                    let valueStart = skipWhitespace(text, colonIndex + 1);
                    let valueEnd = valueStart;
                    let valueString = '';
                    let valueLineComment = false;
                    let valueBlockComment = false;
                    let valueDepth = 0;

                    for (; valueEnd < text.length; valueEnd += 1) {
                        const valueCh = text[valueEnd];
                        const valueNext = text[valueEnd + 1];

                        if (valueLineComment) {
                            if (valueCh === '\n') valueLineComment = false;
                            continue;
                        }
                        if (valueBlockComment) {
                            if (valueCh === '*' && valueNext === '/') {
                                valueBlockComment = false;
                                valueEnd += 1;
                            }
                            continue;
                        }
                        if (valueString) {
                            if (valueCh === '\\') {
                                valueEnd += 1;
                                continue;
                            }
                            if (valueCh === valueString) valueString = '';
                            continue;
                        }

                        if (valueCh === '/' && valueNext === '/') {
                            valueLineComment = true;
                            valueEnd += 1;
                            continue;
                        }
                        if (valueCh === '/' && valueNext === '*') {
                            valueBlockComment = true;
                            valueEnd += 1;
                            continue;
                        }
                        if (valueCh === '"' || valueCh === '\'') {
                            valueString = valueCh;
                            continue;
                        }
                        if (valueCh === '{' || valueCh === '[' || valueCh === '(') {
                            valueDepth += 1;
                            continue;
                        }
                        if (valueCh === '}' || valueCh === ']' || valueCh === ')') {
                            if (valueDepth === 0) {
                                break;
                            }
                            valueDepth -= 1;
                            continue;
                        }
                        if (valueDepth === 0 && valueCh === ',') {
                            break;
                        }
                    }

                    while (valueEnd > valueStart && /\s/.test(text[valueEnd - 1])) {
                        valueEnd -= 1;
                    }

                    return {
                        start: valueStart,
                        end: valueEnd
                    };
                }
            }
        }

        if (ch === '"' || ch === '\'') {
            inString = ch;
            continue;
        }
        if (ch === '{' || ch === '[') {
            depth += 1;
            continue;
        }
        if (ch === '}' || ch === ']') {
            depth -= 1;
            continue;
        }
    }

    return null;
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
