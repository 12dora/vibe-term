import { describe, expect, test } from 'bun:test';
import { acceptHealthzBody, pollHealthz } from './upgrade-health';

const LEGACY_113 = {
  status: 'ok',
  startedAt: 1_788_190_485_291,
  restarting: false,
  env: 'production',
  tmux: { healthy: true },
} as const;

describe('acceptHealthzBody', () => {
  test('legacy 1.1.3 body without version is ok when expectedVersion is omitted', () => {
    expect(acceptHealthzBody(LEGACY_113, { minStartedAt: '2026-08-31T15:34:45.067Z' })).toBeNull();
  });

  test('accepts numeric epoch startedAt from a real 1.1.3 /healthz', () => {
    const body = {
      status: 'ok' as const,
      startedAt: 1_788_190_485_291,
      restarting: false,
      env: 'production',
      tmux: {
        healthy: true,
        clientVersion: 'tmux 3.7b',
        clientProvenance: null,
        serverVersion: '3.7b',
        reason: 'ok',
      },
    };
    expect(acceptHealthzBody(body, { minStartedAt: '2026-08-31T15:34:45.067Z' })).toBeNull();
  });

  test('legacy 1.1.3 body fails the strict candidate version check', () => {
    const reject = acceptHealthzBody(LEGACY_113, { expectedVersion: '1.1.4' });
    expect(reject).toMatch(/1\.1\.4/);
  });

  test('1.0.2 status-only body is accepted', () => {
    expect(acceptHealthzBody({ status: 'ok' }, { statusOnly: true })).toBeNull();
  });

  test('1.1.3 numeric epoch startedAt still works with minStartedAt', () => {
    expect(
      acceptHealthzBody(
        { status: 'ok', startedAt: 1_788_190_485_291 },
        { minStartedAt: '2026-08-31T15:34:45.067Z' }
      )
    ).toBeNull();
  });

  test('requireTlsListener only blocks selfsigned/acme when listener is down', () => {
    expect(
      acceptHealthzBody(
        { status: 'ok', version: '1.1.4', tls: { mode: 'none', listenerRunning: false } },
        { expectedVersion: '1.1.4', requireTlsListener: true }
      )
    ).toBeNull();
    expect(
      acceptHealthzBody(
        { status: 'ok', version: '1.1.4', tls: { mode: 'external', listenerRunning: false } },
        { expectedVersion: '1.1.4', requireTlsListener: true }
      )
    ).toBeNull();
    expect(
      acceptHealthzBody(
        { status: 'ok', version: '1.1.4', tls: { mode: 'selfsigned', listenerRunning: false } },
        { expectedVersion: '1.1.4', requireTlsListener: true }
      )
    ).toMatch(/TLS|listener/i);
    expect(
      acceptHealthzBody(
        { status: 'ok', version: '1.1.4', tls: { mode: 'acme', listenerRunning: true } },
        { expectedVersion: '1.1.4', requireTlsListener: true }
      )
    ).toBeNull();
  });

  test('rejects status other than ok', () => {
    expect(acceptHealthzBody({ status: 'degraded', startedAt: LEGACY_113.startedAt }, {})).toMatch(
      /degraded/
    );
  });

  test('rejects startedAt older than the restart moment', () => {
    const reject = acceptHealthzBody(LEGACY_113, { minStartedAt: '2026-08-31T15:34:46.000Z' });
    expect(reject).toMatch(/startedAt/);
  });

  test('new version body must match expectedVersion', () => {
    expect(
      acceptHealthzBody(
        { status: 'ok', version: '1.1.4', startedAt: LEGACY_113.startedAt },
        {
          expectedVersion: '1.1.4',
        }
      )
    ).toBeNull();
    expect(
      acceptHealthzBody(
        { status: 'ok', version: '1.1.3', startedAt: LEGACY_113.startedAt },
        {
          expectedVersion: '1.1.4',
        }
      )
    ).toMatch(/1\.1\.4/);
  });
});

describe('pollHealthz', () => {
  test('accepts a live 1.0.2 body that only has status ok', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return Response.json({ status: 'ok' });
      },
    });
    try {
      await pollHealthz({
        url: `http://127.0.0.1:${server.port}/healthz`,
        statusOnly: true,
        timeoutMs: 5_000,
      });
    } finally {
      server.stop(true);
    }
  });

  test('accepts a live 1.1.3-shaped /healthz without version', async () => {
    const startedAt = Date.now();
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return Response.json({
          status: 'ok',
          startedAt,
          restarting: false,
          env: 'production',
          tmux: { healthy: true },
        });
      },
    });
    try {
      await pollHealthz({
        url: `http://127.0.0.1:${server.port}/healthz`,
        minStartedAt: new Date(Date.now() - 1_000).toISOString(),
        timeoutMs: 5_000,
      });
    } finally {
      server.stop(true);
    }
  });

  test('still requires version when expectedVersion is set', async () => {
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch() {
        return Response.json({
          status: 'ok',
          startedAt: new Date().toISOString(),
          restarting: false,
          env: 'production',
          tmux: true,
        });
      },
    });
    try {
      await expect(
        pollHealthz({
          url: `http://127.0.0.1:${server.port}/healthz`,
          expectedVersion: '1.1.4',
          timeoutMs: 1_500,
        })
      ).rejects.toThrow(/1\.1\.4/);
    } finally {
      server.stop(true);
    }
  });
});
