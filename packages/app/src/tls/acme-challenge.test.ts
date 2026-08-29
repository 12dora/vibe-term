import { describe, expect, test } from 'bun:test';
import { AcmeHttp01Challenge } from './acme-challenge';

describe('AcmeHttp01Challenge', () => {
  test('serves stored tokens and 404s unknown ones', async () => {
    const challenge = new AcmeHttp01Challenge();
    challenge.set('tok-1', 'tok-1.thumb');
    const hit = challenge.handle(new Request('http://127.0.0.1/.well-known/acme-challenge/tok-1'));
    expect(hit?.status).toBe(200);
    expect(hit?.headers.get('content-type')).toBe('text/plain');
    expect(await hit?.text()).toBe('tok-1.thumb');

    const miss = challenge.handle(
      new Request('http://127.0.0.1/.well-known/acme-challenge/missing')
    );
    expect(miss?.status).toBe(404);
  });

  test('returns 404 for malformed percent-encoding instead of throwing', () => {
    const challenge = new AcmeHttp01Challenge();
    const res = challenge.handle(
      new Request('http://127.0.0.1/.well-known/acme-challenge/%E0%A4%A')
    );
    expect(res).not.toBeNull();
    expect(res?.status).toBe(404);
  });

  test('rejects tokens outside the ACME base64url alphabet or longer than 256', () => {
    const challenge = new AcmeHttp01Challenge();
    challenge.set('ok_Token-1', 'auth');
    expect(
      challenge.handle(new Request('http://127.0.0.1/.well-known/acme-challenge/ok_Token-1'))
        ?.status
    ).toBe(200);

    expect(
      challenge.handle(new Request('http://127.0.0.1/.well-known/acme-challenge/foo.bar'))?.status
    ).toBe(404);
    expect(
      challenge.handle(new Request('http://127.0.0.1/.well-known/acme-challenge/foo/bar'))?.status
    ).toBe(404);
    expect(
      challenge.handle(
        new Request(`http://127.0.0.1/.well-known/acme-challenge/${'a'.repeat(257)}`)
      )?.status
    ).toBe(404);
    expect(
      challenge.handle(new Request('http://127.0.0.1/.well-known/acme-challenge/'))?.status
    ).toBe(404);
  });
});
