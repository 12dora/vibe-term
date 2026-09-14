import { describe, expect, test } from 'bun:test';
import type { RelaySecrets } from './relay-secrets';
import { type RelaySwitchDeps, type RelayUplinkView, runRelaySwitch } from './relay-switch-route';

const SH = 'https://sh.example';
const JP = 'https://jp.example';

function deps(over: {
  persist?: string[];
  switched?: string[];
  prepared?: string[];
  reasons?: Array<string | null>;
  switchTo?: RelayUplinkView['switchTo'];
}): RelaySwitchDeps {
  const persist = over.persist ?? [];
  const switched = over.switched ?? [];
  const prepared = over.prepared ?? [];
  const reasons = over.reasons ?? [];
  return {
    secrets: {
      setPreferredRelayUrl: (url: string) => persist.push(url),
    } as unknown as RelaySecrets,
    uplink: {
      liveClient: () => ({ state: 'online' }) as never,
      attachedHub: () => ({
        publicUrl: SH,
        hubNodeId: null,
        mode: 'active',
        writerEpoch: 0,
        since: 1,
      }),
      reconfigure: async () => {},
      candidates: () => [],
      switchTo:
        over.switchTo ??
        (async (url) => {
          switched.push(url);
          return { ok: true as const };
        }),
      prepareSwitch: async (url) => {
        prepared.push(url);
      },
      noteSwitchReason: (reason) => {
        reasons.push(reason);
      },
    },
  };
}

describe('runRelaySwitch persistPin', () => {
  test('manual path writes preferred and notes manual', async () => {
    const persist: string[] = [];
    const switched: string[] = [];
    const prepared: string[] = [];
    const reasons: Array<string | null> = [];
    const result = await runRelaySwitch(deps({ persist, switched, prepared, reasons }), JP, {
      persistPin: true,
    });
    expect(result).toEqual({ ok: true });
    expect(prepared).toEqual([JP]);
    expect(switched).toEqual([JP]);
    expect(persist).toEqual([JP]);
    expect(reasons).toEqual(['manual']);
  });

  test('auto path does not write preferred and notes auto-rtt', async () => {
    const persist: string[] = [];
    const switched: string[] = [];
    const reasons: Array<string | null> = [];
    const autoPreferred: string[] = [];
    const input = deps({ persist, switched, reasons });
    input.uplink.noteAutoPreferred = (url) => {
      if (url) autoPreferred.push(url);
    };
    const result = await runRelaySwitch(input, JP, {
      persistPin: false,
    });
    expect(result).toEqual({ ok: true });
    expect(switched).toEqual([JP]);
    expect(persist).toEqual([]);
    expect(reasons).toEqual(['auto-rtt']);
    expect(autoPreferred).toEqual([JP]);
  });

  test('failed switch does not persist pin', async () => {
    const persist: string[] = [];
    const reasons: Array<string | null> = [];
    const result = await runRelaySwitch(
      deps({
        persist,
        reasons,
        switchTo: async () => ({ ok: false, reason: 'connect-failed' }),
      }),
      JP,
      { persistPin: true }
    );
    expect(result.ok).toBe(false);
    expect(persist).toEqual([]);
    expect(reasons).toEqual(['manual', null]);
  });
});
