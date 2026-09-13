import { afterEach, describe, expect, test } from 'bun:test';
import { rm } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { UsageError } from '../core/errors';
import { command as agent } from './agent';
import { routeFetch, testContext } from './cli-test-harness';

const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const session = {
  id: 's-1',
  title: 'New Session',
  nodeId: null,
  deviceId: 'd-1',
  paneId: '%0',
  providerId: 'p-1',
  modelId: 'gpt-test',
  systemPrompt: null,
  writeMode: 'confirm' as const,
  useProviderWebSearch: false,
  providerHostedTools: [],
  allowControlChars: false,
  originPaneTitle: null,
  originProcessName: null,
  status: 'idle' as const,
  lastError: null,
  maxStepsPerTurn: 25,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const message = {
  id: 'm-1',
  sessionId: 's-1',
  seq: 1,
  role: 'user' as const,
  content: 'hello',
  createdAt: '2026-01-01T00:00:01.000Z',
};

const queued = {
  id: 'q-1',
  sessionId: 's-1',
  seq: 1,
  text: 'later',
  createdAt: '2026-01-01T00:00:02.000Z',
};

async function ctx(routes: Parameters<typeof routeFetch>[0], json = true) {
  const built = await testContext(routeFetch(routes), { json });
  dirs.push(built.dir);
  return built;
}

async function withStdin<T>(text: string, run: () => Promise<T>): Promise<T> {
  const original = process.stdin;
  const stream = Readable.from([text]) as unknown as NodeJS.ReadStream;
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
  try {
    return await run();
  } finally {
    Object.defineProperty(process, 'stdin', { configurable: true, value: original });
  }
}

describe('vibeterm agent', () => {
  test('ls lists sessions', async () => {
    let path = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/agent/sessions': (url) => {
        path = url.pathname;
        return { sessions: [session] };
      },
    });
    await agent.run(cli, ['ls']);
    expect(path).toBe('/api/agent/sessions');
    expect(JSON.parse(stdout.text()).sessions[0].id).toBe('s-1');
  });

  test('ls prints a table without --json', async () => {
    const { ctx: cli, stdout } = await ctx(
      {
        'GET /api/agent/sessions': () => ({ sessions: [session] }),
      },
      false
    );
    await agent.run(cli, ['ls']);
    const text = stdout.text();
    expect(text).toContain('TITLE');
    expect(text).toContain('New Session');
    expect(text).toContain('idle');
  });

  test('show loads session and messages', async () => {
    const seen: string[] = [];
    const { ctx: cli, stdout } = await ctx({
      'GET /api/agent/sessions/s-1': (url) => {
        seen.push(url.pathname);
        return { session };
      },
      'GET /api/agent/sessions/s-1/messages': (url) => {
        seen.push(url.pathname);
        return { messages: [message] };
      },
    });
    await agent.run(cli, ['show', 's-1']);
    expect(seen).toEqual(['/api/agent/sessions/s-1', '/api/agent/sessions/s-1/messages']);
    const payload = JSON.parse(stdout.text()) as { session: { id: string }; messages: unknown[] };
    expect(payload.session.id).toBe('s-1');
    expect(payload.messages).toHaveLength(1);
  });

  test('new posts device, pane and default writeMode', async () => {
    let body = '';
    const { ctx: cli, stdout } = await ctx({
      'POST /api/agent/sessions': (_url, init) => {
        body = String(init?.body);
        return { session };
      },
    });
    await agent.run(cli, ['new', '--device', 'd-1', '--pane', '%0']);
    expect(JSON.parse(body)).toEqual({
      deviceId: 'd-1',
      paneId: '%0',
      writeMode: 'confirm',
    });
    expect(JSON.parse(stdout.text()).session.id).toBe('s-1');
  });

  test('new --title creates then patches', async () => {
    const calls: Array<{ method: string; path: string; body: unknown }> = [];
    const { ctx: cli } = await ctx({
      'POST /api/agent/sessions': (_url, init) => {
        calls.push({
          method: 'POST',
          path: '/api/agent/sessions',
          body: JSON.parse(String(init?.body)),
        });
        return { session };
      },
      'PATCH /api/agent/sessions/s-1': (_url, init) => {
        calls.push({
          method: 'PATCH',
          path: '/api/agent/sessions/s-1',
          body: JSON.parse(String(init?.body)),
        });
        return { session: { ...session, title: 'Plan' } };
      },
    });
    await agent.run(cli, [
      'new',
      '--device',
      'd-1',
      '--pane',
      '%0',
      '--provider',
      'p-1',
      '--model',
      'gpt-test',
      '--write-mode',
      'auto',
      '--title',
      'Plan',
    ]);
    expect(calls[0].body).toMatchObject({
      deviceId: 'd-1',
      paneId: '%0',
      providerId: 'p-1',
      modelId: 'gpt-test',
      writeMode: 'auto',
    });
    expect(calls[1]).toEqual({
      method: 'PATCH',
      path: '/api/agent/sessions/s-1',
      body: { title: 'Plan' },
    });
  });

  test('new --origin-title posts originPaneTitle', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/agent/sessions': (_url, init) => {
        body = String(init?.body);
        return { session };
      },
    });
    await agent.run(cli, ['new', '--device', 'd-1', '--pane', '%0', '--origin-title', 'vim']);
    expect(JSON.parse(body)).toEqual({
      deviceId: 'd-1',
      paneId: '%0',
      writeMode: 'confirm',
      originPaneTitle: 'vim',
    });
  });

  test('new requires device and pane', async () => {
    const { ctx: cli } = await ctx({});
    await expect(agent.run(cli, ['new', '--device', 'd-1'])).rejects.toBeInstanceOf(UsageError);
  });

  test('rm deletes with --yes', async () => {
    let path = '';
    const { ctx: cli, stdout } = await ctx({
      'DELETE /api/agent/sessions/s-1': (url) => {
        path = url.pathname;
        return { success: true };
      },
    });
    await agent.run(cli, ['rm', 's-1', '--yes']);
    expect(path).toBe('/api/agent/sessions/s-1');
    expect(JSON.parse(stdout.text())).toEqual({ success: true });
  });

  test('rm without --yes is a usage error on a non-TTY', async () => {
    const { ctx: cli } = await ctx({});
    await expect(agent.run(cli, ['rm', 's-1'])).rejects.toBeInstanceOf(UsageError);
  });

  test('rename patches title', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/agent/sessions/s-1': (_url, init) => {
        body = String(init?.body);
        return { session: { ...session, title: 'Renamed' } };
      },
    });
    await agent.run(cli, ['rename', 's-1', 'Renamed']);
    expect(JSON.parse(body)).toEqual({ title: 'Renamed' });
  });

  test('send posts the text', async () => {
    let body = '';
    const { ctx: cli, stdout } = await ctx({
      'POST /api/agent/sessions/s-1/messages': (_url, init) => {
        body = String(init?.body);
        return { message };
      },
    });
    await agent.run(cli, ['send', 's-1', 'hello']);
    expect(JSON.parse(body)).toEqual({ text: 'hello' });
    expect(JSON.parse(stdout.text()).message.id).toBe('m-1');
  });

  test('send --stdin reads stdin', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/agent/sessions/s-1/messages': (_url, init) => {
        body = String(init?.body);
        return { queued };
      },
    });
    await withStdin('from stdin', () => agent.run(cli, ['send', 's-1', '--stdin']));
    expect(JSON.parse(body)).toEqual({ text: 'from stdin' });
  });

  test('steer enqueues with steer:true', async () => {
    let body = '';
    let path = '';
    const { ctx: cli } = await ctx({
      'POST /api/agent/sessions/s-1/queue': (url, init) => {
        path = url.pathname;
        body = String(init?.body);
        return { queued };
      },
    });
    await agent.run(cli, ['steer', 's-1', 'course correct']);
    expect(path).toBe('/api/agent/sessions/s-1/queue');
    expect(JSON.parse(body)).toEqual({ text: 'course correct', steer: true });
  });

  test('queue ls lists the session queue', async () => {
    let path = '';
    const { ctx: cli, stdout } = await ctx({
      'GET /api/agent/sessions/s-1/queue': (url) => {
        path = url.pathname;
        return { queued: [queued] };
      },
    });
    await agent.run(cli, ['queue', 'ls', 's-1']);
    expect(path).toBe('/api/agent/sessions/s-1/queue');
    expect(JSON.parse(stdout.text()).queued[0].id).toBe('q-1');
  });

  test('queue edit patches the item', async () => {
    let body = '';
    let path = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/agent/queue/q-1': (url, init) => {
        path = url.pathname;
        body = String(init?.body);
        return { queued: { ...queued, text: 'edited' } };
      },
    });
    await agent.run(cli, ['queue', 'edit', 's-1', 'q-1', 'edited']);
    expect(path).toBe('/api/agent/queue/q-1');
    expect(JSON.parse(body)).toEqual({ text: 'edited' });
  });

  test('queue rm deletes the item', async () => {
    let path = '';
    const { ctx: cli, stdout } = await ctx({
      'DELETE /api/agent/queue/q-1': (url) => {
        path = url.pathname;
        return { success: true };
      },
    });
    await agent.run(cli, ['queue', 'rm', 's-1', 'q-1']);
    expect(path).toBe('/api/agent/queue/q-1');
    expect(JSON.parse(stdout.text())).toEqual({ success: true });
  });

  test('stop posts the stop endpoint', async () => {
    let path = '';
    const { ctx: cli } = await ctx({
      'POST /api/agent/sessions/s-1/stop': (url) => {
        path = url.pathname;
        return { session: { ...session, status: 'stopped' } };
      },
    });
    await agent.run(cli, ['stop', 's-1']);
    expect(path).toBe('/api/agent/sessions/s-1/stop');
  });

  test('confirm approve posts decided true', async () => {
    let body = '';
    let path = '';
    const { ctx: cli, stdout } = await ctx({
      'POST /api/agent/confirmations/c-1/decide': (url, init) => {
        path = url.pathname;
        body = String(init?.body);
        return { confirmation: { id: 'c-1', status: 'approved' } };
      },
    });
    await agent.run(cli, ['confirm', 'c-1', 'approve']);
    expect(path).toBe('/api/agent/confirmations/c-1/decide');
    expect(JSON.parse(body)).toEqual({ approved: true });
    expect(JSON.parse(stdout.text()).confirmation.status).toBe('approved');
  });

  test('confirm deny --reason posts both fields', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'POST /api/agent/confirmations/c-1/decide': (_url, init) => {
        body = String(init?.body);
        return { confirmation: { id: 'c-1', status: 'denied' } };
      },
    });
    await agent.run(cli, ['confirm', 'c-1', 'deny', '--reason', 'too risky']);
    expect(JSON.parse(body)).toEqual({ approved: false, reason: 'too risky' });
  });

  test('confirm 409 emits conflict', async () => {
    const { ctx: cli, stdout } = await ctx({
      'POST /api/agent/confirmations/c-1/decide': () =>
        new Response(JSON.stringify({ error: 'conflict' }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        }),
    });
    await agent.run(cli, ['confirm', 'c-1', 'approve']);
    expect(JSON.parse(stdout.text())).toEqual({ result: 'conflict' });
  });

  test('model patches provider and model', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/agent/sessions/s-1': (_url, init) => {
        body = String(init?.body);
        return { session: { ...session, providerId: 'p-2', modelId: 'other' } };
      },
    });
    await agent.run(cli, ['model', 's-1', '--provider', 'p-2', '--model', 'other']);
    expect(JSON.parse(body)).toEqual({ providerId: 'p-2', modelId: 'other' });
  });

  test('set --write-mode patches the session', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/agent/sessions/s-1': (_url, init) => {
        body = String(init?.body);
        return { session: { ...session, writeMode: 'auto' } };
      },
    });
    await agent.run(cli, ['set', 's-1', '--write-mode', 'auto']);
    expect(JSON.parse(body)).toEqual({ writeMode: 'auto' });
  });

  test('set --allow-control-chars patches boolean', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/agent/sessions/s-1': (_url, init) => {
        body = String(init?.body);
        return { session: { ...session, allowControlChars: true } };
      },
    });
    await agent.run(cli, ['set', 's-1', '--allow-control-chars', 'on']);
    expect(JSON.parse(body)).toEqual({ allowControlChars: true });
  });

  test('set --pane patches paneId', async () => {
    let body = '';
    const { ctx: cli } = await ctx({
      'PATCH /api/agent/sessions/s-1': (_url, init) => {
        body = String(init?.body);
        return { session: { ...session, paneId: '%9' } };
      },
    });
    await agent.run(cli, ['set', 's-1', '--pane', '%9']);
    expect(JSON.parse(body)).toEqual({ paneId: '%9' });
  });

  test('confirmations ls hits GET /api/agent/sessions/:id/confirmations', async () => {
    let path = '';
    const confirmation = {
      id: 'c-1',
      sessionId: 's-1',
      toolName: 'write',
      toolCallId: 't-1',
      input: { path: '/tmp/a' },
      status: 'pending',
      reason: null,
      decidedAt: null,
      createdAt: '2026-01-01T00:00:03.000Z',
    };
    const { ctx: cli, stdout } = await ctx({
      'GET /api/agent/sessions/s-1/confirmations': (url) => {
        path = url.pathname;
        return { confirmations: [confirmation] };
      },
    });
    await agent.run(cli, ['confirmations', 'ls', 's-1']);
    expect(path).toBe('/api/agent/sessions/s-1/confirmations');
    expect(JSON.parse(stdout.text()).confirmations[0].id).toBe('c-1');
  });

  test('set without flags is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(agent.run(cli, ['set', 's-1'])).rejects.toBeInstanceOf(UsageError);
  });

  test('unknown subcommand is a usage error', async () => {
    const { ctx: cli } = await ctx({});
    await expect(agent.run(cli, ['nope'])).rejects.toBeInstanceOf(UsageError);
  });

  test('show rejects extra arguments', async () => {
    const { ctx: cli } = await ctx({});
    await expect(agent.run(cli, ['show', 's-1', 'extra'])).rejects.toBeInstanceOf(UsageError);
  });
});
