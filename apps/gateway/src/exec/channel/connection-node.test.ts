import { afterEach, describe, expect, test } from 'bun:test';
import { EcKind } from '@vibeterm/shared/exec-channel';
import { liveSessionCount, resetExecRegistryForTests } from './registry';
import { connect, flush, makeEnv } from './test-harness';

afterEach(() => resetExecRegistryForTests());

async function open(selfNodeName: () => string | null, nodeName: string | undefined) {
  const env = makeEnv();
  env.deps.selfNodeName = selfNodeName;
  const client = connect(env);
  client.send(EcKind.HELLO, {
    v: 1,
    op: 'open',
    spec: {
      command: { kind: 'shell', script: 'x' },
      stdin: true,
      ...(nodeName ? { nodeName } : {}),
    },
  });
  await flush();
  return { env, client };
}

describe('expected node name check', () => {
  test('a renamed node rejects the stale name as device_not_found without spawning', async () => {
    const { env, client } = await open(() => 'office-new', 'office');
    const error = client.transport.json<{ code: string; message: string }>(EcKind.ERROR)[0];
    expect(error).toEqual({ code: 'device_not_found', message: 'node mismatch' });
    expect(env.procs).toHaveLength(0);
    expect(liveSessionCount()).toBe(0);
  });

  test('the matching name opens normally, ignoring case and padding', async () => {
    const { client } = await open(() => ' Office ', 'office');
    expect(client.transport.json(EcKind.READY)).toHaveLength(1);
    expect(client.transport.json(EcKind.ERROR)).toHaveLength(0);
  });

  test('no name in the spec skips the check', async () => {
    const { client } = await open(() => 'office', undefined);
    expect(client.transport.json(EcKind.READY)).toHaveLength(1);
  });

  test('a gateway without a known name cannot verify and lets the open through', async () => {
    const { client } = await open(() => null, 'office');
    expect(client.transport.json(EcKind.READY)).toHaveLength(1);
  });
});
