import { describe, expect, test } from 'bun:test';
import { encodeBase64url, encodeSetTotpPayload, encryptTotpSecret } from '@tmex/shared/auth';
import { KeyLogStore } from '../auth/key-log-store';
import { NodeSessionStore } from '../auth/node-session-store';
import { createMigratedAuthDb } from '../auth/test-db';
import { UserKeyService } from '../auth/user-key-service';
import { UserStore } from '../auth/user-store';
import { FakePeers, FakeStreams, asResponse, bootMesh, dummyServer } from './auth-routes.test';
import { handleTotpRecord } from './auth-totp-record';

const OTHER = 'bb'.repeat(16);

describe('handleTotpRecord cache control', () => {
  test('sets Cache-Control private, no-store on success and error', async () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const userStore = new UserStore(db);
      const keyLogStore = new KeyLogStore(db);
      const nodeSessionStore = new NodeSessionStore(db);
      const keyLogService = new UserKeyService({ db, userStore, keyLogStore, nodeSessionStore });
      const denied = handleTotpRecord({ userStore, keyLogService }, null);
      expect(denied.status).toBe(401);
      expect(denied.headers.get('Cache-Control')).toBe('private, no-store');

      const boot = await keyLogService.bootstrapUser({ username: 'alice', password: 'tmex-test' });
      const missing = handleTotpRecord({ userStore, keyLogService }, boot.userId);
      expect(missing.status).toBe(404);
      expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
      expect(await missing.json()).toEqual({ code: 'TOTP_NOT_ENABLED' });

      const unknown = handleTotpRecord({ userStore, keyLogService }, 'missing-user');
      expect(unknown.status).toBe(404);
      expect(unknown.headers.get('Cache-Control')).toBe('private, no-store');

      const payload = await encryptTotpSecret(
        new Uint8Array(32).fill(3),
        new Uint8Array(20).fill(7),
        {
          uid: boot.userId,
          root_epoch: 1,
          seq: 2n,
        }
      );
      const applied = await keyLogService.signAndApply(boot.userId, boot.rootKey, {
        type: 'set-totp',
        payload: encodeSetTotpPayload(payload),
      });
      expect(applied.ok).toBe(true);
      const ok = handleTotpRecord({ userStore, keyLogService }, boot.userId);
      expect(ok.status).toBe(200);
      expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
      const body = (await ok.json()) as { payload: string; root_epoch: number };
      expect(body.root_epoch).toBe(1);
      expect(encodeBase64url(encodeSetTotpPayload(payload)).length).toBeGreaterThan(0);
      expect(body.payload.length).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  test('forwarded /n/:id/api/auth/totp-record keeps Cache-Control private, no-store', async () => {
    const peers = new FakePeers();
    peers.links.set(OTHER, {} as import('@tmex/shared/link').LinkSession);
    const streams = new FakeStreams();
    streams.nextResponse = new Response(
      JSON.stringify({ record_seq: 2, root_epoch: 1, payload: 'x' }),
      {
        headers: {
          'content-type': 'application/json',
          'Cache-Control': 'private, no-store',
        },
      }
    );
    const mesh = await bootMesh({ peers, streams });
    try {
      const ok = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/auth/totp-record`),
          dummyServer
        )
      );
      expect(ok.status).toBe(200);
      expect(ok.headers.get('Cache-Control')).toBe('private, no-store');
      expect(streams.lastOpen?.path).toBe('/api/auth/totp-record');

      streams.nextResponse = new Response(JSON.stringify({ code: 'TOTP_NOT_ENABLED' }), {
        status: 404,
        headers: {
          'content-type': 'application/json',
          'Cache-Control': 'private, no-store',
        },
      });
      const missing = asResponse(
        await mesh.runtime.handleRequest(
          new Request(`http://localhost/n/${OTHER}/api/auth/totp-record`),
          dummyServer
        )
      );
      expect(missing.status).toBe(404);
      expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
    } finally {
      mesh.close();
    }
  });
});
