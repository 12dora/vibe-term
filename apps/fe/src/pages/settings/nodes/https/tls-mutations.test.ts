// TLS 变更锁：保存 / 续签互斥、ACME 签发期间全禁用、失败后必须重拉状态、停监听前必须确认。

import { describe, expect, test } from 'bun:test';
import { ApiClient } from '@tmex/api-client';
import { TlsApi, TlsApiError } from '@tmex/api-client/local/tls-api';
import type { TlsStatusResponse, TlsUpdateRequest } from '@tmex/api-client/local/tls-types';
import { TlsMutationController, isTlsBusy, stopsRunningListener } from './tls-mutations';

function tls(overrides: Partial<TlsStatusResponse> = {}): TlsStatusResponse {
  return {
    mode: 'selfsigned',
    trustProxy: false,
    tlsPort: 9443,
    bindHost: '0.0.0.0',
    sans: ['hub.lan'],
    caFingerprint: null,
    certificate: null,
    listener: { running: true, port: 9443, error: null },
    acme: null,
    restartRequired: false,
    ...overrides,
  };
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface Harness {
  controller: TlsMutationController;
  calls: string[];
  events: string[];
  errors: unknown[];
  setStatus: (next: TlsStatusResponse | null) => void;
  nextUpdate: () => Deferred<TlsStatusResponse>;
  nextRenew: () => Deferred<TlsStatusResponse>;
}

function harness(initial: TlsStatusResponse | null = tls()): Harness {
  let status = initial;
  const calls: string[] = [];
  const events: string[] = [];
  const errors: unknown[] = [];
  const updates: Deferred<TlsStatusResponse>[] = [];
  const renews: Deferred<TlsStatusResponse>[] = [];

  const api = new TlsApi(new ApiClient('', () => Promise.resolve(new Response('{}'))));
  api.update = (req: TlsUpdateRequest) => {
    calls.push(`update:${req.mode}`);
    const pending = deferred<TlsStatusResponse>();
    updates.push(pending);
    return pending.promise;
  };
  api.renew = () => {
    calls.push('renew');
    const pending = deferred<TlsStatusResponse>();
    renews.push(pending);
    return pending.promise;
  };

  const controller = new TlsMutationController(
    api,
    () => status,
    () => ({
      onStatus: (next) => {
        status = next;
        events.push('status');
      },
      onRefresh: () => events.push('refresh'),
      onSaved: () => events.push('saved'),
      onRenewStarted: () => events.push('renewStarted'),
      onError: (error) => {
        events.push('error');
        errors.push(error);
      },
    })
  );

  return {
    controller,
    calls,
    events,
    errors,
    setStatus: (next) => {
      status = next;
    },
    nextUpdate: () => {
      const pending = updates.shift();
      if (!pending) throw new Error('no pending update');
      return pending;
    },
    nextRenew: () => {
      const pending = renews.shift();
      if (!pending) throw new Error('no pending renew');
      return pending;
    },
  };
}

describe('stopsRunningListener / isTlsBusy', () => {
  test('只有停掉正在运行的监听才需要确认', () => {
    const running = tls();
    const stopped = tls({ listener: { running: false, port: null, error: null } });
    expect(stopsRunningListener({ mode: 'none' }, running)).toBe(true);
    expect(stopsRunningListener({ mode: 'external', trustProxy: true }, running)).toBe(true);
    expect(
      stopsRunningListener(
        { mode: 'selfsigned', sans: ['a.lan'], tlsPort: 9443, bindHost: '::' },
        running
      )
    ).toBe(false);
    expect(stopsRunningListener({ mode: 'none' }, stopped)).toBe(false);
    expect(stopsRunningListener({ mode: 'none' }, null)).toBe(false);
  });

  test('ACME 后台签发期间同样算忙', () => {
    const pendingAcme = tls({
      acme: {
        email: 'ops@example.com',
        domain: 'hub.example.com',
        challenge: 'http-01',
        staging: false,
        status: 'pending',
        lastError: null,
        lastAttemptAt: null,
        nextRenewAt: null,
        hasCloudflareToken: false,
      },
    });
    expect(isTlsBusy(null, pendingAcme)).toBe(true);
    expect(isTlsBusy(null, tls())).toBe(false);
    expect(isTlsBusy('save', tls())).toBe(true);
    expect(isTlsBusy('renew', tls())).toBe(true);
  });
});

describe('TlsMutationController 串行化', () => {
  const selfsigned: TlsUpdateRequest = {
    mode: 'selfsigned',
    sans: ['hub.lan'],
    tlsPort: 9443,
    bindHost: '0.0.0.0',
  };

  test('保存在途时续签被拒（不会打到接口）', async () => {
    const h = harness();
    const saving = h.controller.requestSave(selfsigned);
    expect(h.controller.snapshot().pending).toBe('save');

    await h.controller.renew();
    expect(h.calls).toEqual(['update:selfsigned']);

    h.nextUpdate().resolve(tls());
    await saving;
    expect(h.controller.snapshot().pending).toBeNull();
    expect(h.events).toEqual(['status', 'saved']);
  });

  test('续签在途时保存被拒', async () => {
    const h = harness();
    const renewing = h.controller.renew();
    expect(h.controller.snapshot().pending).toBe('renew');

    await h.controller.requestSave(selfsigned);
    expect(h.calls).toEqual(['renew']);

    h.nextRenew().resolve(tls());
    await renewing;
    expect(h.events).toEqual(['status', 'renewStarted']);
  });

  test('ACME 签发期间保存与续签都被拒', async () => {
    const h = harness(
      tls({
        mode: 'acme',
        acme: {
          email: 'ops@example.com',
          domain: 'hub.example.com',
          challenge: 'http-01',
          staging: false,
          status: 'pending',
          lastError: null,
          lastAttemptAt: null,
          nextRenewAt: null,
          hasCloudflareToken: false,
        },
      })
    );
    await h.controller.requestSave(selfsigned);
    await h.controller.renew();
    expect(h.calls).toEqual([]);
  });

  test('订阅者在每次状态迁移时被唤醒', async () => {
    const h = harness();
    let notifications = 0;
    const unsubscribe = h.controller.subscribe(() => {
      notifications += 1;
    });
    const saving = h.controller.requestSave(selfsigned);
    h.nextUpdate().resolve(tls());
    await saving;
    unsubscribe();
    expect(notifications).toBe(2);
  });
});

describe('TlsMutationController 失败路径', () => {
  const selfsigned: TlsUpdateRequest = {
    mode: 'selfsigned',
    sans: ['hub.lan'],
    tlsPort: 9443,
    bindHost: '0.0.0.0',
  };

  test('保存 port_in_use：报错之后必须重拉状态（模式已落库但没绑上端口）', async () => {
    const h = harness();
    const saving = h.controller.requestSave(selfsigned);
    h.nextUpdate().reject(new TlsApiError('port_in_use', 'address in use', 409));
    await saving;
    expect(h.events).toEqual(['error', 'refresh']);
    expect((h.errors[0] as TlsApiError).code).toBe('port_in_use');
    expect(h.controller.snapshot().pending).toBeNull();
  });

  test('续签失败同样重拉状态（自签可能已经换过证书才绑端口失败）', async () => {
    const h = harness();
    const renewing = h.controller.renew();
    h.nextRenew().reject(new TlsApiError('port_in_use', 'address in use', 409));
    await renewing;
    expect(h.events).toEqual(['error', 'refresh']);
    expect(h.controller.snapshot().pending).toBeNull();
  });
});

describe('TlsMutationController 停监听确认', () => {
  test('监听运行中切到 none：先登记确认，确认后才 PUT', async () => {
    const h = harness();
    await h.controller.requestSave({ mode: 'none' });
    expect(h.calls).toEqual([]);
    expect(h.controller.snapshot().confirming).toEqual({ mode: 'none' });

    const confirming = h.controller.confirmSave();
    expect(h.controller.snapshot().confirming).toBeNull();
    expect(h.calls).toEqual(['update:none']);
    h.nextUpdate().resolve(
      tls({ mode: 'none', listener: { running: false, port: null, error: null } })
    );
    await confirming;
    expect(h.events).toEqual(['status', 'saved']);
  });

  test('取消确认不发请求', async () => {
    const h = harness();
    await h.controller.requestSave({ mode: 'external', trustProxy: true });
    h.controller.cancelSave();
    expect(h.controller.snapshot().confirming).toBeNull();
    expect(h.calls).toEqual([]);
  });

  test('监听没在跑时直接保存，不弹确认', async () => {
    const h = harness(tls({ listener: { running: false, port: null, error: null } }));
    const saving = h.controller.requestSave({ mode: 'none' });
    expect(h.controller.snapshot().confirming).toBeNull();
    expect(h.calls).toEqual(['update:none']);
    h.nextUpdate().resolve(tls({ mode: 'none' }));
    await saving;
  });

  test('确认对话框挂着时不再受理新的保存或续签', async () => {
    const h = harness();
    await h.controller.requestSave({ mode: 'none' });
    await h.controller.requestSave({ mode: 'external', trustProxy: false });
    await h.controller.renew();
    expect(h.calls).toEqual([]);
    expect(h.controller.snapshot().confirming).toEqual({ mode: 'none' });
  });
});
