import { describe, expect, test } from 'bun:test';
import { loadAgentRuntime } from './lazy';

describe('agent/lazy', () => {
  test('loadAgentRuntime memoizes supervisor exports', async () => {
    const first = await loadAgentRuntime();
    const second = await loadAgentRuntime();
    expect(first).toBe(second);
    expect(typeof first.agentSupervisor.start).toBe('function');
    expect(first.agentSupervisor).toBe(second.agentSupervisor);
  });
});
