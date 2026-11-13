import { describe, expect, test } from 'bun:test';
import {
  keyLogCommitDb,
  runAfterKeyLogCommit,
  withKeyLogCommitSideEffects,
} from './revocation-after-commit';
import { createMigratedAuthDb } from './test-db';

describe('withKeyLogCommitSideEffects', () => {
  test('runs queued jobs only after work returns, and uses the outer db', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const order: string[] = [];
      withKeyLogCommitSideEffects(db, () => {
        order.push('work');
        runAfterKeyLogCommit(() => {
          order.push('job');
          expect(keyLogCommitDb()).toBe(db);
        });
        expect(order).toEqual(['work']);
      });
      expect(order).toEqual(['work', 'job']);
    } finally {
      close();
    }
  });

  test('a thrown transaction does not run queued jobs', () => {
    const { db, close } = createMigratedAuthDb();
    try {
      const ran: string[] = [];
      expect(() =>
        withKeyLogCommitSideEffects(db, () => {
          runAfterKeyLogCommit(() => ran.push('job'));
          throw new Error('rollback');
        })
      ).toThrow('rollback');
      expect(ran).toEqual([]);
      runAfterKeyLogCommit(() => ran.push('immediate'));
      expect(ran).toEqual(['immediate']);
    } finally {
      close();
    }
  });
});
