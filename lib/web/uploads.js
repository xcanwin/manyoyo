'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 聊天里的图片：宿主机写进容器状态目录的 box/uploads/（以读写方式挂在容器的 /run/manyoyo/ 下），
// 不经过 exec，也不碰用户的工作目录。文件名由服务端生成，绝不使用用户给的名字。
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_IMAGES = 5;
const CONTAINER_UPLOAD_DIR = '/run/manyoyo/uploads';
const IMAGE_PATH_PATTERN = /^\/run\/manyoyo\/uploads\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/;
const CONTENT_TYPE_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

function extForContentType(contentType) {
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    return Object.prototype.hasOwnProperty.call(CONTENT_TYPE_EXT, type) ? CONTENT_TYPE_EXT[type] : '';
}

// 声明的类型要和文件头对得上（防止把别的东西冒充图片）
function matchesImageMagic(ext, head) {
    if (ext === 'png') return head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if (ext === 'jpg') return head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    if (ext === 'gif') return head.length >= 6 && /^GIF8[79]a$/.test(head.subarray(0, 6).toString('latin1'));
    if (ext === 'webp') return head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    return false;
}

/** 请求里的 images：没给返回 []，给了但不合规抛错 */
function parseImages(value) {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value) || value.length > MAX_IMAGES) {
        throw new Error(`images 必须是数组，最多 ${MAX_IMAGES} 张`);
    }
    for (const item of value) {
        if (typeof item !== 'string' || !IMAGE_PATH_PATTERN.test(item)) {
            throw new Error('images 里有不合法的路径');
        }
    }
    return [...new Set(value)];
}

// 追加在提示词末尾：Claude / Gemini / OpenCode 等没有专门的传图参数，让它们用读文件的工具去看
function appendImageNote(prompt, images) {
    if (!images || !images.length) return prompt;
    return `${prompt}\n\n附图（请用 Read 工具查看）：\n${images.map(item => `- ${item}`).join('\n')}`;
}

/**
 * 把请求体写进 uploadsDir（边读边计数，超限中止并删除半截文件）。
 * @returns {Promise<{ok: true, name: string} | {ok: false, status: number, error: string}>}
 */
function saveUpload(req, uploadsDir, ext) {
    return new Promise(resolve => {
        fs.mkdirSync(uploadsDir, { recursive: true, mode: 0o755 });
        const name = `${crypto.randomBytes(12).toString('hex')}.${ext}`;
        const finalPath = path.join(uploadsDir, name);
        const tmpPath = `${finalPath}.part`;
        const out = fs.createWriteStream(tmpPath, { flags: 'wx', mode: 0o644 });
        let size = 0;
        let head = Buffer.alloc(0);
        let finished = false;
        const fail = (status, error) => {
            if (finished) return;
            finished = true;
            req.unpipe(out);
            out.destroy();
            fs.rm(tmpPath, { force: true }, () => resolve({ ok: false, status, error }));
            if (status === 413) req.resume();
        };
        req.on('data', chunk => {
            if (finished) return;
            size += chunk.length;
            if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
            if (size > MAX_IMAGE_BYTES) fail(413, '图片不能超过 10MB');
        });
        req.on('aborted', () => fail(400, '上传被中断'));
        req.on('error', () => fail(400, '上传失败'));
        out.on('error', () => fail(500, '保存图片失败'));
        out.on('finish', () => {
            if (finished) return;
            if (size === 0) { fail(400, '图片内容为空'); return; }
            if (!matchesImageMagic(ext, head)) { fail(400, '文件内容和图片类型不符'); return; }
            finished = true;
            try {
                fs.renameSync(tmpPath, finalPath);
                resolve({ ok: true, name });
            } catch (e) {
                fs.rm(tmpPath, { force: true }, () => resolve({ ok: false, status: 500, error: '保存图片失败' }));
            }
        });
        req.pipe(out);
    });
}

module.exports = {
    MAX_IMAGE_BYTES,
    MAX_IMAGES,
    CONTAINER_UPLOAD_DIR,
    IMAGE_PATH_PATTERN,
    extForContentType,
    matchesImageMagic,
    parseImages,
    appendImageNote,
    saveUpload
};
