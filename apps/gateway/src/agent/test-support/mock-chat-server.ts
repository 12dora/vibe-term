import { afterAll } from 'bun:test';

export interface ChatCompletionChunkDelta {
  role?: string;
  content?: string;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
}

export interface RecordedRequest {
  body: { messages: Array<Record<string, unknown>>; tools?: unknown[] };
}

export function chunk(delta: ChatCompletionChunkDelta, finishReason: string | null = null) {
  return {
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 1700000000,
    model: 'mock-model',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}

export function sseResponse(chunks: unknown[]): Response {
  const body = `${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')}data: [DONE]\n\n`;
  return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
}

export function slowSseResponse(chunks: unknown[], delayMs: number): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(c)}\n\n`));
        await new Promise((r) => setTimeout(r, delayMs));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
}

export function useMockChatServer(): typeof createMockChatServer {
  const servers: Array<ReturnType<typeof Bun.serve>> = [];
  afterAll(() => {
    for (const server of servers) {
      server.stop(true);
    }
  });
  return (respond) => {
    const mock = createMockChatServer(respond);
    servers.push(mock.server);
    return mock;
  };
}

export function createMockChatServer(
  respond: (callIndex: number, req: RecordedRequest) => Response
) {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== '/v1/chat/completions' || req.method !== 'POST') {
        return new Response('not found', { status: 404 });
      }
      const recorded: RecordedRequest = {
        body: (await req.json()) as RecordedRequest['body'],
      };
      requests.push(recorded);
      return respond(requests.length - 1, recorded);
    },
  });
  return { server, requests, baseUrl: `http://127.0.0.1:${server.port}/v1` };
}
