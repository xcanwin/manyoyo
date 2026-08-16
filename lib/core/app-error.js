'use strict';

const crypto = require('crypto');

class AppError extends Error {
    constructor(options = {}) {
        const summary = String(options.summary || '服务暂时不可用');
        super(summary);
        this.name = 'AppError';
        this.code = String(options.code || 'INTERNAL_ERROR');
        this.summary = summary;
        this.detail = typeof options.detail === 'string' ? options.detail : '';
        this.retryable = options.retryable === true;
        this.action = typeof options.action === 'string' ? options.action : '';
        this.correlationId = String(options.correlationId || crypto.randomUUID());
        this.statusCode = Number.isInteger(options.statusCode) ? options.statusCode : 500;
    }
}

function toAppError(error) {
    if (error instanceof AppError) {
        return error;
    }
    return new AppError({
        code: 'INTERNAL_ERROR',
        summary: '服务暂时不可用',
        retryable: true,
        action: '请稍后重试',
        statusCode: 500
    });
}

function toErrorPayload(error) {
    const appError = toAppError(error);
    return {
        error: {
            code: appError.code,
            summary: appError.summary,
            detail: appError.detail,
            retryable: appError.retryable,
            action: appError.action,
            correlationId: appError.correlationId
        }
    };
}

function toHttpAppError(statusCode, payload = {}) {
    if (payload.error instanceof AppError) {
        return payload.error;
    }

    const message = typeof payload.error === 'string' ? payload.error : '';
    const definitions = {
        400: ['INVALID_REQUEST', message || '请求参数错误', false],
        401: ['UNAUTHORIZED', message === 'UNAUTHORIZED' ? '未登录或登录已过期' : (message || '未登录或登录已过期'), false],
        403: ['FORBIDDEN', message || '没有执行此操作的权限', false],
        404: ['NOT_FOUND', message || '请求的资源不存在', false],
        409: ['CONFLICT', message || '请求与当前状态冲突', false],
        429: ['RATE_LIMITED', message || '请求过于频繁，请稍后重试', true]
    };
    const definition = definitions[statusCode];
    if (definition) {
        return new AppError({
            code: definition[0],
            summary: definition[1],
            detail: typeof payload.detail === 'string' ? payload.detail : '',
            retryable: definition[2],
            action: definition[2] ? '请稍后重试' : '',
            statusCode
        });
    }

    return toAppError(payload.error instanceof Error ? payload.error : new Error(message));
}

module.exports = {
    AppError,
    toAppError,
    toErrorPayload,
    toHttpAppError
};
