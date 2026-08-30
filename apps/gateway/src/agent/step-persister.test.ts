import { describe, expect, test } from 'bun:test';
import { StepMessagePersister } from './step-persister';

describe('StepMessagePersister', () => {
  test('一次把累积 messages 的新增后缀整批交给 persist', () => {
    const batches: string[][] = [];
    const persister = new StepMessagePersister<{ role: string; id: string }>((messages) => {
      batches.push(messages.map((message) => message.id));
    });

    persister.persistNewMessages([
      { role: 'assistant', id: 'a1' },
      { role: 'tool', id: 't1' },
    ]);
    expect(batches).toEqual([['a1', 't1']]);

    persister.persistNewMessages([
      { role: 'assistant', id: 'a1' },
      { role: 'tool', id: 't1' },
      { role: 'assistant', id: 'a2' },
    ]);
    expect(batches).toEqual([['a1', 't1'], ['a2']]);
  });

  test('空数组不落库；等长重复调用是 no-op', () => {
    const batches: string[][] = [];
    const persister = new StepMessagePersister<{ role: string; id: string }>((messages) => {
      batches.push(messages.map((message) => message.id));
    });
    persister.persistNewMessages([]);
    persister.persistNewMessages([{ role: 'assistant', id: 'a1' }]);
    persister.persistNewMessages([{ role: 'assistant', id: 'a1' }]);
    expect(batches).toEqual([['a1']]);
  });
});
