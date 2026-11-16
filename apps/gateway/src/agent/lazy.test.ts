import { afterEach, describe, expect, test } from 'bun:test';
import { setLiveServicesEnabled } from '../live-start-gates';
import { ensureAgentSupervisor, loadAgentRuntime } from './lazy';

afterEach(() => {
  setLiveServicesEnabled(false);
});

describe('agent/lazy', () => {
  test('loadAgentRuntime memoizes supervisor exports', async () => {
    const first = await loadAgentRuntime();
    const second = await loadAgentRuntime();
    expect(first).toBe(second);
    expect(typeof first.agentSupervisor.start).toBe('function');
    expect(first.agentSupervisor).toBe(second.agentSupervisor);
  });

  test('ensureAgentSupervisor starts only when live services are enabled', async () => {
    const { agentSupervisor } = await loadAgentRuntime();
    const calls: string[] = [];
    const original = agentSupervisor.start.bind(agentSupervisor);
    agentSupervisor.start = async () => {
      calls.push('start');
    };
    try {
      expect(await ensureAgentSupervisor()).toBe(agentSupervisor);
      expect(calls).toEqual([]);
      setLiveServicesEnabled(true);
      await ensureAgentSupervisor();
      await ensureAgentSupervisor();
      expect(calls).toEqual(['start', 'start']);
    } finally {
      agentSupervisor.start = original;
    }
  });
});
