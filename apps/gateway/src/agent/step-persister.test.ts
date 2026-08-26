import { describe, expect, test } from 'bun:test';
import { StepMessagePersister } from './step-persister';

describe('StepMessagePersister', () => {
  test('只落累积 messages 的新增后缀，第二次调用不重复', () => {
    const persisted: string[] = [];
    const persister = new StepMessagePersister<{ role: string; id: string }>((message) => {
      persisted.push(message.id);
    });

    persister.persistNewMessages([
      { role: 'assistant', id: 'a1' },
      { role: 'tool', id: 't1' },
    ]);
    expect(persisted).toEqual(['a1', 't1']);

    persister.persistNewMessages([
      { role: 'assistant', id: 'a1' },
      { role: 'tool', id: 't1' },
      { role: 'assistant', id: 'a2' },
    ]);
    expect(persisted).toEqual(['a1', 't1', 'a2']);
  });

  test('空数组不落库；等长重复调用是 no-op', () => {
    const persisted: string[] = [];
    const persister = new StepMessagePersister<{ role: string; id: string }>((message) => {
      persisted.push(message.id);
    });
    persister.persistNewMessages([]);
    persister.persistNewMessages([{ role: 'assistant', id: 'a1' }]);
    persister.persistNewMessages([{ role: 'assistant', id: 'a1' }]);
    expect(persisted).toEqual(['a1']);
  });
});
