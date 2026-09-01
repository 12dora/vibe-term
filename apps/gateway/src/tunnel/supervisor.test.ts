import { describe, expect, test } from 'bun:test';
import { FakeHandle } from './fake-spawn';
import { LogRingBuffer } from './log-buffer';
import type { CloudflaredProvider } from './provider';
import { TunnelSupervisor } from './supervisor';

async function waitFor(pred: () => boolean, timeoutMs = 1_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await Bun.sleep(5);
  }
  throw new Error('condition not reached');
}

function makeSupervisor(handle: FakeHandle): TunnelSupervisor {
  const logs = new LogRingBuffer(50);
  const provider = {
    spawnNamedRun: async () => handle,
    spawnQuickRun: async () => handle,
  } as unknown as CloudflaredProvider;
  return new TunnelSupervisor({
    provider,
    logs,
    sleep: async () => {},
    killTimeoutMs: 20,
  });
}

describe('TunnelSupervisor edge connections', () => {
  test('JSON register/unregister degrades and recovers without restarting', async () => {
    const handle = new FakeHandle({ hold: true });
    const supervisor = makeSupervisor(handle);
    await supervisor.start({
      bin: '/usr/bin/cloudflared',
      mode: 'named',
      originUrl: 'http://127.0.0.1:19883',
      configPath: '/tmp/config.yml',
    });
    expect(supervisor.state).toBe('starting');

    handle.writeStdout('{"level":"info","message":"Registered tunnel connection","connIndex":0}\n');
    await waitFor(() => supervisor.state === 'running');
    expect(supervisor.edgeConnections).toBe(1);

    handle.writeStdout('{"level":"info","message":"Registered tunnel connection","connIndex":1}\n');
    await waitFor(() => supervisor.edgeConnections === 2);

    handle.writeStdout(
      '{"level":"info","message":"Unregistered tunnel connection","connIndex":0}\n'
    );
    handle.writeStdout(
      '{"level":"error","error":"i/o timeout","message":"Connection terminated","connIndex":1}\n'
    );
    await waitFor(() => supervisor.state === 'degraded');
    expect(supervisor.edgeConnections).toBe(0);
    expect(supervisor.lastError).toContain('i/o timeout');
    expect(supervisor.pid).toBe(handle.pid);

    handle.writeStdout('{"level":"info","message":"Registered tunnel connection","connIndex":0}\n');
    await waitFor(() => supervisor.state === 'running');
    expect(supervisor.edgeConnections).toBe(1);

    await supervisor.stop();
  });

  test('text-format register/unregister degrades and recovers', async () => {
    const handle = new FakeHandle({ hold: true });
    const supervisor = makeSupervisor(handle);
    await supervisor.start({
      bin: '/usr/bin/cloudflared',
      mode: 'quick',
      originUrl: 'http://127.0.0.1:19883',
      configPath: '/tmp/config.yml',
    });

    handle.writeStdout(
      '2026-09-02T12:00:00Z INF Registered tunnel connection connIndex=0 location=sjc\n'
    );
    await waitFor(() => supervisor.state === 'running');
    expect(supervisor.edgeConnections).toBe(1);

    handle.writeStdout(
      '2026-09-02T12:00:01Z ERR Unable to establish connection with Cloudflare edge\n'
    );
    handle.writeStdout('2026-09-02T12:00:02Z INF Unregistered tunnel connection connIndex=0\n');
    await waitFor(() => supervisor.state === 'degraded');
    expect(supervisor.lastError).toContain('Unable to establish connection');

    handle.writeStdout('2026-09-02T12:00:03Z INF Registered tunnel connection connIndex=0\n');
    await waitFor(() => supervisor.state === 'running');

    handle.writeStdout('2026-09-02T12:00:04Z INF Connection terminated connIndex=0 event=x\n');
    await waitFor(() => supervisor.state === 'degraded');

    await supervisor.stop();
    expect(supervisor.state).toBe('stopped');
    expect(supervisor.edgeConnections).toBe(0);
  });
});
