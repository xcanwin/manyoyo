'use strict';

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

function skipTrivia(text, index) {
    let cursor = index;
    while (cursor < text.length) {
        const ch = text[cursor];
        const next = text[cursor + 1];
        if (/\s/.test(ch)) {
            cursor += 1;
            continue;
        }
        if (ch === '/' && next === '/') {
            cursor += 2;
            while (cursor < text.length && text[cursor] !== '\n') {
                cursor += 1;
            }
            continue;
        }
        if (ch === '/' && next === '*') {
            cursor += 2;
            while (cursor + 1 < text.length && !(text[cursor] === '*' && text[cursor + 1] === '/')) {
                cursor += 1;
            }
            cursor = cursor + 1 < text.length ? cursor + 2 : text.length;
            continue;
        }
        break;
    }
    return cursor;
}

function scanValueEnd(text, startIndex) {
    let cursor = startIndex;
    let stringQuote = '';
    let lineComment = false;
    let blockComment = false;
    let depth = 0;

    for (; cursor < text.length; cursor += 1) {
        const ch = text[cursor];
        const next = text[cursor + 1];

        if (lineComment) {
            if (ch === '\n') {
                lineComment = false;
            }
            continue;
        }
        if (blockComment) {
            if (ch === '*' && next === '/') {
                blockComment = false;
                cursor += 1;
            }
            continue;
        }
        if (stringQuote) {
            if (ch === '\\') {
                cursor += 1;
                continue;
            }
            if (ch === stringQuote) {
                stringQuote = '';
            }
            continue;
        }

        if (ch === '/' && next === '/') {
            lineComment = true;
            cursor += 1;
            continue;
        }
        if (ch === '/' && next === '*') {
            blockComment = true;
            cursor += 1;
            continue;
        }
        if (ch === '"' || ch === '\'') {
            stringQuote = ch;
            continue;
        }
        if (ch === '{' || ch === '[' || ch === '(') {
            depth += 1;
            continue;
        }
        if (ch === '}' || ch === ']' || ch === ')') {
            if (depth === 0) {
                break;
            }
            depth -= 1;
            continue;
        }
        if (depth === 0 && ch === ',') {
            break;
        }
    }

    let end = cursor;
    while (end > startIndex && /\s/.test(text[end - 1])) {
        end -= 1;
    }
    return end;
}

function findRootObjectStart(text) {
    const source = String(text || '');
    const start = skipTrivia(source, 0);
    return source[start] === '{' ? start : -1;
}

function readPropertyToken(text, startIndex) {
    const ch = text[startIndex];
    if (ch === '"' || ch === '\'') {
        return readQuotedString(text, startIndex);
    }
    if (!isIdentifierStart(ch)) {
        return null;
    }

    let end = startIndex + 1;
    while (end < text.length && isIdentifierPart(text[end])) {
        end += 1;
    }
    return {
        value: text.slice(startIndex, end),
        end
    };
}

function findObjectPropertyValueRange(text, objectStartIndex, propertyName) {
    let cursor = skipTrivia(text, objectStartIndex + 1);
    while (cursor < text.length) {
        cursor = skipTrivia(text, cursor);
        if (text[cursor] === '}') {
            return null;
        }
        const token = readPropertyToken(text, cursor);
        if (!token) {
            return null;
        }
        cursor = skipTrivia(text, token.end);
        if (text[cursor] !== ':') {
            return null;
        }
        const valueStart = skipTrivia(text, cursor + 1);
        const valueEnd = scanValueEnd(text, valueStart);
        if (token.value === propertyName) {
            return { start: valueStart, end: valueEnd };
        }
        cursor = skipTrivia(text, valueEnd);
        if (text[cursor] === ',') {
            cursor += 1;
            continue;
        }
        if (text[cursor] === '}') {
            return null;
        }
    }
    return null;
}

function findValueRangeByPath(text, pathParts) {
    if (!Array.isArray(pathParts) || pathParts.length === 0) {
        return null;
    }

    let objectStart = findRootObjectStart(text);
    if (objectStart === -1) {
        return null;
    }

    let range = null;
    for (let i = 0; i < pathParts.length; i += 1) {
        range = findObjectPropertyValueRange(text, objectStart, pathParts[i]);
        if (!range) {
            return null;
        }
        if (i === pathParts.length - 1) {
            return range;
        }
        const nextObjectStart = skipTrivia(text, range.start);
        if (text[nextObjectStart] !== '{') {
            return null;
        }
        objectStart = nextObjectStart;
    }
    return range;
}

function findTopLevelPropertyValueRange(text, propertyName) {
    return findValueRangeByPath(text, [propertyName]);
}

function applyTextReplacements(text, replacements) {
    return replacements
        .slice()
        .sort((a, b) => b.start - a.start)
        .reduce((result, item) => `${result.slice(0, item.start)}${item.text}${result.slice(item.end)}`, text);
}

function formatPropertyKey(key) {
    return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? key : JSON.stringify(key);
}

// 永远只在对象的 '{' 后面插入，不管这个对象原来是空的还是已经有属性——
// 不用去判断"是不是最后一个属性、要不要补逗号"，语法上总是安全的
function insertObjectProperty(text, objectStartIndex, key, valueText) {
    const prefix = `\n    ${formatPropertyKey(key)}: `;
    const insertion = `${prefix}${valueText},`;
    const insertPos = objectStartIndex + 1;
    const nextText = `${text.slice(0, insertPos)}${insertion}${text.slice(insertPos)}`;
    return { text: nextText, valueStart: insertPos + prefix.length };
}

// findValueRangeByPath 的"读+建"版本：路径上缺失的中间对象会被逐级创建，
// 最终这个 key 已存在就原地替换值，不存在就插入新属性；已有内容/注释不受影响。
// 路径中间遇到"已存在但不是对象"的值会直接抛错，不做任何改动（避免静默吞掉用户数据）。
function upsertValueByPath(text, pathParts, valueText) {
    if (!Array.isArray(pathParts) || pathParts.length === 0) {
        throw new Error('path 不能为空');
    }

    let objectStart = findRootObjectStart(text);
    if (objectStart === -1) {
        throw new Error('未找到根对象');
    }

    let currentText = text;
    let currentObjectStart = objectStart;

    for (let i = 0; i < pathParts.length; i += 1) {
        const key = pathParts[i];
        const isLast = i === pathParts.length - 1;
        const existingRange = findObjectPropertyValueRange(currentText, currentObjectStart, key);

        if (existingRange) {
            if (isLast) {
                return applyTextReplacements(currentText, [
                    { start: existingRange.start, end: existingRange.end, text: valueText }
                ]);
            }
            const nextObjectStart = skipTrivia(currentText, existingRange.start);
            if (currentText[nextObjectStart] !== '{') {
                throw new Error(`路径 ${pathParts.slice(0, i + 1).join('.')} 已存在且不是对象，无法继续`);
            }
            currentObjectStart = nextObjectStart;
            continue;
        }

        const inserted = insertObjectProperty(currentText, currentObjectStart, key, isLast ? valueText : '{}');
        currentText = inserted.text;
        if (isLast) {
            return currentText;
        }
        currentObjectStart = inserted.valueStart;
    }

    return currentText;
}

module.exports = {
    findTopLevelPropertyValueRange,
    findValueRangeByPath,
    applyTextReplacements,
    upsertValueByPath
};
