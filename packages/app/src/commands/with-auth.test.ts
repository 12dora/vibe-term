import { afterEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { LocalAuthContext } from '../lib/local-auth';
import * as localAuth from '../lib/local-auth';
import type { ParsedArgs } from '../types';
import { withAuth } from './with-auth';

const parsed: ParsedArgs = { command: null, positionals: [], flags: {} };

function fakeCtx(): LocalAuthContext {
  return { close: mock(() => {}) } as unknown as LocalAuthContext;
}

afterEach(() => {
  mock.restore();
});

describe('withAuth', () => {
  test('uses io.auth and does not close it', async () => {
    const auth = fakeCtx();
    const result = await withAuth(parsed, { auth }, async (ctx) => {
      expect(ctx).toBe(auth);
      return 42;
    });
    expect(result).toBe(42);
    expect(auth.close).not.toHaveBeenCalled();
  });

  test('does not close io.auth when fn throws', async () => {
    const auth = fakeCtx();
    await expect(
      withAuth(parsed, { auth }, async () => {
        throw new Error('handler failed');
      })
    ).rejects.toThrow('handler failed');
    expect(auth.close).not.toHaveBeenCalled();
  });

  test('opens install auth, forwards the result, and closes', async () => {
    const opened = fakeCtx();
    const open = spyOn(localAuth, 'openInstallAuth').mockResolvedValue(opened);
    const result = await withAuth(parsed, undefined, async (ctx) => {
      expect(ctx).toBe(opened);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0]?.[0]).toBe(parsed);
    expect(opened.close).toHaveBeenCalledTimes(1);
  });

  test('closes opened auth when fn throws', async () => {
    const opened = fakeCtx();
    spyOn(localAuth, 'openInstallAuth').mockResolvedValue(opened);
    await expect(
      withAuth(parsed, {}, async () => {
        throw new Error('handler failed');
      })
    ).rejects.toThrow('handler failed');
    expect(opened.close).toHaveBeenCalledTimes(1);
  });

  test('does not close when openInstallAuth throws', async () => {
    const open = spyOn(localAuth, 'openInstallAuth').mockRejectedValue(
      new Error('DATABASE_URL missing from app.env')
    );
    await expect(withAuth(parsed, undefined, async () => 'unused')).rejects.toThrow(
      'DATABASE_URL missing from app.env'
    );
    expect(open).toHaveBeenCalledTimes(1);
  });
});
