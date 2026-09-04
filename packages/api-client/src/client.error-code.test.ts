// 类型化错误的解析：契约错误码（401 NODE_LOGIN_REQUIRED / 503 NODE_UNREACHABLE）
// 与老形态 `{error:"..."}` 都要能还原出 status / code / error / nodeId / reason。

import { describe, expect, test } from 'bun:test';
import {
  ApiClient,
  ApiError,
  NODE_UNREACHABLE,
  isNodeLoginRequiredError,
  isNodeUnreachableError,
  toApiError,
} from './client';
import { fetchDevices } from './devices';

const NODE_ID = '0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a';

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('toApiError', () => {
  test('转发层改写的 401 带上 code / error / nodeId', async () => {
    const error = await toApiError(
      jsonResponse(401, {
        error: 'via_mismatch',
        code: 'NODE_LOGIN_REQUIRED',
        nodeId: NODE_ID,
      }),
      'fallback'
    );
    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(401);
    expect(error.code).toBe('NODE_LOGIN_REQUIRED');
    expect(error.error).toBe('via_mismatch');
    expect(error.nodeId).toBe(NODE_ID);
    expect(error.reason).toBeNull();
    expect(error.message).toBe('via_mismatch');
    expect(isNodeLoginRequiredError(error)).toBe(true);
    expect(isNodeUnreachableError(error)).toBe(false);
  });

  test('503 NODE_UNREACHABLE 带 reason，且没有 error 字段时 message 退到 code', async () => {
    const error = await toApiError(
      jsonResponse(503, { code: NODE_UNREACHABLE, nodeId: NODE_ID, reason: 'no link' }),
      'Failed to load devices'
    );
    expect(error.status).toBe(503);
    expect(error.code).toBe(NODE_UNREACHABLE);
    expect(error.error).toBeNull();
    expect(error.reason).toBe('no link');
    expect(error.message).toBe(NODE_UNREACHABLE);
    expect(isNodeUnreachableError(error)).toBe(true);
    expect(isNodeLoginRequiredError(error)).toBe(false);
  });

  test('老形态 `{error:"..."}` 仍还原成 message，code 为 null', async () => {
    const error = await toApiError(jsonResponse(500, { error: 'boom' }), 'fallback');
    expect(error.message).toBe('boom');
    expect(error.code).toBeNull();
    expect(isNodeLoginRequiredError(error)).toBe(false);
  });

  test('`{error:{message}}` 信封取 message，非 JSON 响应退到 fallback', async () => {
    const enveloped = await toApiError(
      jsonResponse(502, { error: { message: 'bad gateway' } }),
      'fallback'
    );
    expect(enveloped.message).toBe('bad gateway');

    const plain = await toApiError(new Response('<html>', { status: 502 }), 'fallback');
    expect(plain.message).toBe('fallback');
    expect(plain.status).toBe(502);
    expect(plain.code).toBeNull();
  });

  test('转发层把非 JSON 上游体塞进 message 时也能取到', async () => {
    const error = await toApiError(
      jsonResponse(401, { code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_ID, message: 'nope' }),
      'fallback'
    );
    expect(error.message).toBe('nope');
    expect(error.code).toBe('NODE_LOGIN_REQUIRED');
  });

  test('非对象响应体（数组 / 字符串）退到 fallback，不抛', async () => {
    const arrayBody = await toApiError(jsonResponse(400, ['nope']), 'fallback');
    expect(arrayBody.message).toBe('fallback');
    const stringBody = await toApiError(jsonResponse(400, 'nope'), 'fallback');
    expect(stringBody.message).toBe('fallback');
  });
});

describe('fetchDevices 的失败', () => {
  function clientReturning(res: Response): ApiClient {
    return new ApiClient('', () => Promise.resolve(res));
  }

  test('401 NODE_LOGIN_REQUIRED 抛类型化错误而不是裸 Error', async () => {
    const client = clientReturning(
      jsonResponse(401, { error: 'via_mismatch', code: 'NODE_LOGIN_REQUIRED', nodeId: NODE_ID })
    );
    const error = await fetchDevices(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(isNodeLoginRequiredError(error)).toBe(true);
    expect((error as ApiError).nodeId).toBe(NODE_ID);
  });

  test('503 NODE_UNREACHABLE 的 reason 透到调用方', async () => {
    const client = clientReturning(
      jsonResponse(503, { code: NODE_UNREACHABLE, nodeId: NODE_ID, reason: 'node offline' })
    );
    const error = await fetchDevices(client).catch((e: unknown) => e);
    expect(isNodeUnreachableError(error)).toBe(true);
    expect((error as ApiError).reason).toBe('node offline');
  });

  test('没有契约字段的失败仍给出兜底文案', async () => {
    const client = clientReturning(new Response('', { status: 500 }));
    const error = await fetchDevices(client).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).message).toBe('Failed to load devices');
  });
});
