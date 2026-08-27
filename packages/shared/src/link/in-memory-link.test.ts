import { describe, expect, it } from 'bun:test';
import { createInMemoryLinkPair } from './in-memory-link';
import type { LinkStream } from './types';

async function readAllText(stream: LinkStream): Promise<string> {
  const reader = stream.readable.getReader();
  const parts: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) parts.push(new TextDecoder().decode(value.bytes));
  }
  return parts.join('');
}

describe('InMemoryLink', () => {
  it('carries concurrent streams in both directions', async () => {
    const [a, b] = createInMemoryLinkPair();
    const incomingB: LinkStream[] = [];
    const incomingA: LinkStream[] = [];
    b.onStream((stream) => incomingB.push(stream));
    a.onStream((stream) => incomingA.push(stream));

    const aStreams = await Promise.all([
      a.openStream(new TextEncoder().encode('a0')),
      a.openStream(new TextEncoder().encode('a1')),
      a.openStream(new TextEncoder().encode('a2')),
    ]);
    const bStreams = await Promise.all([
      b.openStream(new TextEncoder().encode('b0')),
      b.openStream(new TextEncoder().encode('b1')),
    ]);
    expect(incomingB).toHaveLength(3);
    expect(incomingA).toHaveLength(2);

    await Promise.all([
      ...aStreams.map((stream, i) => stream.write(new TextEncoder().encode(`A${i}`))),
      ...bStreams.map((stream, i) => stream.write(new TextEncoder().encode(`B${i}`))),
    ]);
    for (const stream of [...aStreams, ...bStreams]) stream.end();
    for (const stream of [...incomingA, ...incomingB]) stream.end();

    const fromA = await Promise.all(incomingB.map(readAllText));
    const fromB = await Promise.all(incomingA.map(readAllText));
    expect(fromA.sort()).toEqual(['A0', 'A1', 'A2']);
    expect(fromB.sort()).toEqual(['B0', 'B1']);
    const first = aStreams[0];
    expect(first).toBeDefined();
    if (!first) throw new Error('expected stream');
    expect((await first.closed).reason).toBe('end');
    a.close();
  });
});
