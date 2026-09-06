import { describe, expect, test } from 'bun:test';
import { ApiClient, ApiError } from './client';
import {
  cancelTransferJob,
  createTransferGrant,
  createTransferJob,
  getTransferJob,
  listTransferJobs,
  streamTransferJobEvents,
  transferJobEventsPath,
  transferJobPath,
} from './transfer';

class StubApiClient extends ApiClient {
  calls: Array<{ path: string; init?: RequestInit }> = [];

  constructor(
    private responses: Response[],
    baseUrl = ''
  ) {
    super(baseUrl);
  }

  override fetch(path: string, init?: RequestInit): Promise<Response> {
    this.calls.push({ path, init });
    const next = this.responses.shift();
    if (!next) return Promise.reject(new Error('unexpected request'));
    return Promise.resolve(next);
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function ndjsonResponse(lines: string[]): Response {
  return new Response(lines.map((line) => `${line}\n`).join(''), { status: 200 });
}

const GRANT = { grantId: 'g1', token: 'tok', expiresAt: 1000 };

describe('路径构造', () => {
  test('任务与事件流路径对 jobId 转义', () => {
    expect(transferJobPath('a/b')).toBe('/api/transfer/jobs/a%2Fb');
    expect(transferJobEventsPath('j1')).toBe('/api/transfer/jobs/j1/events');
  });
});

describe('createTransferGrant', () => {
  test('POST 到目标节点，body 即契约请求体', async () => {
    const client = new StubApiClient([jsonResponse(GRANT)], '/n/bb');

    const result = await createTransferGrant(client, {
      fromNodeId: 'aa',
      destRootId: 'r1',
      destPath: '/data',
    });

    expect(client.calls[0].path).toBe('/api/transfer/grants');
    expect(client.calls[0].init?.method).toBe('POST');
    expect(JSON.parse(String(client.calls[0].init?.body))).toEqual({
      fromNodeId: 'aa',
      destRootId: 'r1',
      destPath: '/data',
    });
    expect(result).toEqual(GRANT);
  });

  test('非 2xx 抛带 code 的 ApiError', async () => {
    const client = new StubApiClient([jsonResponse({ code: 'grant_expired' }, 410)]);

    const error = await createTransferGrant(client, {
      fromNodeId: 'aa',
      destRootId: 'r1',
      destPath: '/data',
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('grant_expired');
  });
});

describe('createTransferJob', () => {
  test('POST 到源节点并拆掉 { job } 信封', async () => {
    const client = new StubApiClient([jsonResponse({ job: { jobId: 'j1', state: 'queued' } })]);

    const job = await createTransferJob(client, {
      toNodeId: 'bb',
      items: [{ rootId: 'r0', path: '/src/a.bin' }],
      destRootId: 'r1',
      destPath: '/data',
      grant: { grantId: 'g1', token: 'tok' },
      onConflict: 'skip',
    });

    expect(client.calls[0].path).toBe('/api/transfer/jobs');
    expect(client.calls[0].init?.method).toBe('POST');
    const body = JSON.parse(String(client.calls[0].init?.body));
    expect(body.toNodeId).toBe('bb');
    expect(body.grant).toEqual({ grantId: 'g1', token: 'tok' });
    expect(body.items).toEqual([{ rootId: 'r0', path: '/src/a.bin' }]);
    expect(job.jobId).toBe('j1');
  });
});

describe('listTransferJobs / getTransferJob', () => {
  test('列表拆 { jobs } 信封', async () => {
    const client = new StubApiClient([jsonResponse({ jobs: [{ jobId: 'j1' }, { jobId: 'j2' }] })]);
    const jobs = await listTransferJobs(client);
    expect(client.calls[0].path).toBe('/api/transfer/jobs');
    expect(jobs.map((job) => job.jobId)).toEqual(['j1', 'j2']);
  });

  test('单条拆 { job } 信封并透传 signal', async () => {
    const client = new StubApiClient([jsonResponse({ job: { jobId: 'j1' } })]);
    const controller = new AbortController();
    const job = await getTransferJob(client, 'j1', controller.signal);
    expect(client.calls[0].path).toBe('/api/transfer/jobs/j1');
    expect(client.calls[0].init?.signal).toBe(controller.signal);
    expect(job.jobId).toBe('j1');
  });
});

describe('cancelTransferJob', () => {
  test('DELETE 任务，204 也算成功', async () => {
    const client = new StubApiClient([new Response(null, { status: 204 })]);
    await cancelTransferJob(client, 'j1');
    expect(client.calls[0].path).toBe('/api/transfer/jobs/j1');
    expect(client.calls[0].init?.method).toBe('DELETE');
  });
});

describe('streamTransferJobEvents', () => {
  test('逐行解析 NDJSON 事件', async () => {
    const client = new StubApiClient([
      ndjsonResponse([
        JSON.stringify({ type: 'snapshot', job: { jobId: 'j1' } }),
        JSON.stringify({ type: 'state', jobId: 'j1', state: 'done' }),
        JSON.stringify({ type: 'end' }),
      ]),
    ]);
    const seen: string[] = [];

    await streamTransferJobEvents(client, 'j1', (event) => {
      seen.push(event.type);
    });

    expect(client.calls[0].path).toBe('/api/transfer/jobs/j1/events');
    expect(seen).toEqual(['snapshot', 'state', 'end']);
  });

  test('无响应体时抛错', async () => {
    const client = new StubApiClient([new Response(null, { status: 204 })]);
    await expect(streamTransferJobEvents(client, 'j1', () => {})).rejects.toThrow(
      'transfer events stream has no body'
    );
  });
});
