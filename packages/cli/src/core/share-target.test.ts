import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TmuxSession } from '@vibeterm/shared';
import { NotFoundError, UsageError } from './errors';
import {
  locateShareWindow,
  pickShareOrigin,
  resolveShareOrigin,
  resolveShareTarget,
} from './share-target';
import { createFakeTermContext, fakeSession } from './term-test-fakes';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function harness(session: TmuxSession = fakeSession()) {
  const dir = await mkdtemp(join(tmpdir(), 'vibeterm-cli-share-target-'));
  dirs.push(dir);
  return createFakeTermContext({ session, configDir: dir, json: true, timeoutMs: 1_000 });
}

describe('locateShareWindow', () => {
  const session = fakeSession();

  test('resolves @id, index and name', () => {
    expect(locateShareWindow(session, '@1').id).toBe('@1');
    expect(locateShareWindow(session, '1').id).toBe('@1');
    expect(locateShareWindow(session, 'build').id).toBe('@1');
  });

  test('unknown window is not found', () => {
    expect(() => locateShareWindow(session, 'nope')).toThrow(NotFoundError);
  });

  test('ambiguous name is a usage error', () => {
    const twins: TmuxSession = {
      ...session,
      windows: session.windows.map((window) => ({ ...window, name: 'same' })),
    };
    expect(() => locateShareWindow(twins, 'same')).toThrow(UsageError);
  });
});

describe('pickShareOrigin', () => {
  const candidates = [{ url: 'https://a.example' }, { url: 'https://b.example' }];

  test('uses recommended when it is a candidate', () => {
    expect(pickShareOrigin({ candidates, recommended: 'https://b.example' })).toBe(
      'https://b.example'
    );
  });

  test('falls back to the first candidate', () => {
    expect(pickShareOrigin({ candidates, recommended: 'https://missing.example' })).toBe(
      'https://a.example'
    );
    expect(pickShareOrigin({ candidates, recommended: null })).toBe('https://a.example');
  });

  test('empty list is null', () => {
    expect(pickShareOrigin({ candidates: [], recommended: 'https://a.example' })).toBeNull();
  });
});

describe('resolveShareTarget', () => {
  test('connects the device and resolves a window name to @id', async () => {
    const h = await harness();
    const target = await resolveShareTarget(h.ctx, 'laptop:build', {});
    try {
      expect(target.windowId).toBe('@1');
      expect(target.deviceName).toBe('laptop');
      expect(h.transport.commandsOfType('connect-device')).toHaveLength(1);
      expect(h.closed()).toBe(0);
    } finally {
      target.close();
    }
    expect(h.closed()).toBe(1);
  });

  test('--window-id overrides the target token', async () => {
    const h = await harness();
    const target = await resolveShareTarget(h.ctx, 'laptop:build', { 'window-id': '@0' });
    try {
      expect(target.windowId).toBe('@0');
    } finally {
      target.close();
    }
  });

  test('missing window is a usage error', async () => {
    const h = await harness();
    await expect(resolveShareTarget(h.ctx, 'laptop', {})).rejects.toBeInstanceOf(UsageError);
    expect(h.closed()).toBe(0);
  });

  test('unknown window closes the socket', async () => {
    const h = await harness();
    await expect(resolveShareTarget(h.ctx, 'laptop:nope', {})).rejects.toBeInstanceOf(
      NotFoundError
    );
    expect(h.closed()).toBe(1);
  });
});

describe('resolveShareOrigin', () => {
  test('--origin wins without fetching', async () => {
    const h = await harness();
    await expect(
      resolveShareOrigin(h.ctx, 'self', { origin: 'https://own.example' })
    ).resolves.toBe('https://own.example');
  });
});
