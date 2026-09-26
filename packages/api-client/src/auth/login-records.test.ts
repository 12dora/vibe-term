import { describe, expect, test } from 'bun:test';
import { ApiClient, ApiError } from '../client';
import {
  clearLoginRecords,
  getLoginRecordSettings,
  listLoginRecords,
  loginRecordsPath,
  putLoginRecordSettings,
} from './login-records';

function clientFor(response: Response): { client: ApiClient; urls: string[]; init: RequestInit[] } {
  const urls: string[] = [];
  const init: RequestInit[] = [];
  const client = new ApiClient('', (url, options) => {
    urls.push(url);
    init.push(options ?? {});
    return Promise.resolve(response);
  });
  return { client, urls, init };
}

describe('login record client', () => {
  test('lists with outcome, kind, limit and before', async () => {
    const page = { records: [], nextBefore: null };
    const { client, urls } = clientFor(Response.json(page));
    expect(
      await listLoginRecords(client, {
        outcome: 'success',
        kind: 'all',
        limit: 50,
        before: { at: 1_700_000_000_000, id: 'row-1' },
      })
    ).toEqual(page);
    expect(urls[0]).toBe(
      loginRecordsPath({
        outcome: 'success',
        kind: 'all',
        limit: 50,
        before: { at: 1_700_000_000_000, id: 'row-1' },
      })
    );
    expect(urls[0]).toContain('beforeId=row-1');
    expect(urls[0]).toContain('outcome=success');
    expect(urls[0]).toContain('kind=all');
  });

  test('clears and reads or writes retention', async () => {
    const cleared = clientFor(Response.json({ deleted: 3 }));
    expect(await clearLoginRecords(cleared.client)).toEqual({ deleted: 3 });
    expect(cleared.init[0]?.method).toBe('DELETE');
    expect(cleared.urls[0]).toBe('/api/auth/login-records');

    const settings = { retentionDays: 30 as const };
    const loaded = clientFor(Response.json(settings));
    expect(await getLoginRecordSettings(loaded.client)).toEqual(settings);
    expect(loaded.urls[0]).toBe('/api/auth/login-records/settings');

    const saved = clientFor(Response.json(settings));
    expect(await putLoginRecordSettings(saved.client, settings)).toEqual(settings);
    expect(saved.init[0]?.method).toBe('PUT');
    expect(JSON.parse(String(saved.init[0]?.body))).toEqual(settings);
  });

  test('surfaces the server code on a rejected settings write', async () => {
    const { client } = clientFor(Response.json({ code: 'MALFORMED' }, { status: 400 }));
    const error = await putLoginRecordSettings(client, { retentionDays: 90 }).then(
      () => null,
      (err: unknown) => err
    );
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(400);
    expect((error as ApiError).code).toBe('MALFORMED');
  });
});
