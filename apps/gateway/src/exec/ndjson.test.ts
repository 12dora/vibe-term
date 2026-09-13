import { describe, expect, test } from 'bun:test';
import { execNdjsonResponse } from './ndjson';

async function readEvents(res: Response): Promise<Array<Record<string, unknown>>> {
  const text = await res.text();
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe('execNdjsonResponse keepalive', () => {
  test('emits ping while run is in flight', async () => {
    const res = execNdjsonResponse(
      async (emit, isOpen) => {
        emit({ type: 'start' });
        await Bun.sleep(80);
        expect(isOpen()).toBe(true);
        emit({ type: 'exit', code: 0 });
      },
      () => {},
      30
    );
    const events = await readEvents(res);
    expect(events[0]).toMatchObject({ type: 'start' });
    expect(events.some((e) => e.type === 'ping' && typeof e.t === 'number')).toBe(true);
    expect(events.find((e) => e.type === 'exit')).toMatchObject({ code: 0 });
  });
});
