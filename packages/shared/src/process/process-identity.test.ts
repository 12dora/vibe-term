import { describe, expect, test } from 'bun:test';
import { processCommandLine, processStartIdentity } from './process-identity';

describe('processStartIdentity', () => {
  test('rejects non-positive and non-integer pids', () => {
    expect(processStartIdentity(0)).toBeNull();
    expect(processStartIdentity(-1)).toBeNull();
    expect(processStartIdentity(1.5)).toBeNull();
  });

  test('returns a stable identity for the current process', () => {
    const identity = processStartIdentity(process.pid);
    expect(identity).toBeTruthy();
    expect(processStartIdentity(process.pid)).toBe(identity);
  });

  test('returns null for a pid that does not exist', () => {
    expect(processStartIdentity(2_147_483_647)).toBeNull();
  });
});

describe('processCommandLine', () => {
  test('rejects non-positive and non-integer pids', () => {
    expect(processCommandLine(0)).toBeNull();
    expect(processCommandLine(-1)).toBeNull();
    expect(processCommandLine(1.5)).toBeNull();
  });

  test('returns a command line for the current process', () => {
    const cmd = processCommandLine(process.pid);
    expect(cmd).toBeTruthy();
    expect(cmd).toMatch(/bun|node/i);
  });

  test('returns null for a pid that does not exist', () => {
    expect(processCommandLine(2_147_483_647)).toBeNull();
  });
});
