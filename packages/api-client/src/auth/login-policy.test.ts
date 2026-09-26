import { describe, expect, test } from 'bun:test';
import { standardLoginPolicy } from '@vibeterm/shared/auth';
import type { LoginPolicyStatus } from '@vibeterm/shared/auth';
import { ApiClient } from '../client';
import { getLoginPolicy } from './login-policy';

describe('getLoginPolicy', () => {
  test('GET /api/auth/login-policy', async () => {
    const status: LoginPolicyStatus = {
      policy: standardLoginPolicy(),
      source: 'default',
      writable: true,
      blockers: [],
    };
    let url = '';
    const client = new ApiClient('', (requested) => {
      url = requested;
      return Promise.resolve(Response.json(status));
    });
    expect(await getLoginPolicy(client)).toEqual(status);
    expect(url).toBe('/api/auth/login-policy');
  });
});
