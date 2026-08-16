'use strict';

const {
    AppError,
    toAppError,
    toErrorPayload,
    toHttpAppError
} = require('../lib/core/app-error');

describe('AppError contract', () => {
    test('normalizes unknown errors to a safe, retryable internal error', () => {
        const error = toAppError(new Error('database password=secret'));

        expect(error).toEqual(expect.objectContaining({
            code: 'INTERNAL_ERROR',
            summary: '服务暂时不可用',
            retryable: true,
            statusCode: 500
        }));
        expect(toErrorPayload(error)).toEqual(expect.objectContaining({
            error: expect.objectContaining({
                code: 'INTERNAL_ERROR',
                summary: '服务暂时不可用',
                retryable: true,
                correlationId: expect.any(String)
            })
        }));
    });

    test('preserves explicit public errors without exposing internal detail by default', () => {
        const error = new AppError({
            code: 'INVALID_REQUEST',
            summary: '请求参数错误',
            detail: 'containerName 非法: demo!',
            retryable: false,
            statusCode: 400
        });

        expect(toErrorPayload(error)).toEqual({
            error: {
                code: 'INVALID_REQUEST',
                summary: '请求参数错误',
                detail: 'containerName 非法: demo!',
                retryable: false,
                action: '',
                correlationId: expect.any(String)
            }
        });
    });

    test('maps HTTP errors to stable codes and never exposes an unexpected server error', () => {
        expect(toErrorPayload(toHttpAppError(401, { error: 'UNAUTHORIZED' }))).toEqual({
            error: expect.objectContaining({
                code: 'UNAUTHORIZED',
                summary: '未登录或登录已过期',
                retryable: false
            })
        });
        expect(toErrorPayload(toHttpAppError(500, { error: new Error('token=secret') }))).toEqual({
            error: expect.objectContaining({
                code: 'INTERNAL_ERROR',
                summary: '服务暂时不可用',
                detail: ''
            })
        });
    });
});
