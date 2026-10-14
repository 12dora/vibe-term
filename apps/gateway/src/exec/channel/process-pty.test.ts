import { describe, expect, test } from 'bun:test';
import { spawnExecProcess } from './process';
import { collect, openSpec, readUntil, testDevice } from './process-test-util';
import { ptySupported } from './pty';

const device = testDevice();
const ptyTest = ptySupported() ? test : test.skip;

type PtyDims = { cols: number; rows: number; term?: string };

function ptySpec(script: string, pty: PtyDims = { cols: 80, rows: 24 }) {
  return openSpec({ command: { kind: 'shell', script, sh: true }, pty, stdin: true });
}

describe('local pty process', () => {
  ptyTest('runs on a tty, reports the pty flag and nothing on stderr', async () => {
    const proc = await spawnExecProcess(device, ptySpec('test -t 0 && test -t 1 && echo istty'));
    expect(proc.pty).toBe(true);
    expect(await proc.readStderr()).toBeNull();
    const text = Buffer.from(await collect(() => proc.readStdout())).toString('utf8');
    expect(text).toContain('istty');
    expect(await proc.exited).toEqual({ code: 0, signal: null });
    expect(await proc.readStdout()).toBeNull();
  });

  ptyTest('sets TERM from the pty spec', async () => {
    const proc = await spawnExecProcess(
      device,
      ptySpec('echo term=$TERM', { cols: 80, rows: 24, term: 'vt100' })
    );
    const text = Buffer.from(await collect(() => proc.readStdout())).toString('utf8');
    expect(text).toContain('term=vt100');
  });

  ptyTest('resize reaches the child terminal', async () => {
    const proc = await spawnExecProcess(
      device,
      ptySpec('stty size; read line; stty size', { cols: 80, rows: 24 })
    );
    await readUntil(proc, '24 80');
    proc.resize(132, 43);
    await proc.writeStdin(new TextEncoder().encode('go\n'));
    const rest = await readUntil(proc, '43 132');
    expect(rest).toContain('43 132');
    await proc.exited;
  });

  ptyTest('echoes input and treats endStdin as EOF', async () => {
    const proc = await spawnExecProcess(device, ptySpec('cat'));
    await proc.writeStdin(new TextEncoder().encode('ping\n'));
    await readUntil(proc, 'ping');
    await proc.endStdin();
    expect((await proc.exited).code).toBe(0);
    await collect(() => proc.readStdout());
  });

  ptyTest('kill ends the pty process group by signal', async () => {
    const proc = await spawnExecProcess(device, ptySpec('sleep 30'));
    proc.kill();
    expect((await proc.exited).signal).toBe('SIGTERM');
    expect(await collect(() => proc.readStdout())).toBeInstanceOf(Buffer);
  });

  ptyTest('writes after exit resolve without throwing', async () => {
    const proc = await spawnExecProcess(device, ptySpec('true'));
    await proc.exited;
    await collect(() => proc.readStdout());
    await proc.writeStdin(new Uint8Array([1, 2, 3]));
    await proc.endStdin();
    proc.resize(100, 30);
  });
});
