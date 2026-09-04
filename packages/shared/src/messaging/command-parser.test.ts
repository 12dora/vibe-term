import { describe, expect, test } from 'bun:test';
import { parseCommand, tokenize } from './command-parser';

describe('tokenize', () => {
  test('splits on whitespace and keeps quoted groups', () => {
    expect(tokenize(`run "dev 1" %0 -- echo hi`)).toEqual([
      'run',
      'dev 1',
      '%0',
      '--',
      'echo',
      'hi',
    ]);
  });

  test('supports single quotes and backslash escapes', () => {
    expect(tokenize(`cmd 'a b' "c\\"d"`)).toEqual(['cmd', 'a b', 'c"d']);
  });
});

describe('parseCommand', () => {
  test('parses a slash command', () => {
    expect(parseCommand('/help')).toEqual({ ok: true, name: 'help', args: [] });
  });

  test('parses a command without a leading slash', () => {
    expect(parseCommand('status')).toEqual({ ok: true, name: 'status', args: [] });
  });

  test('strips Telegram /cmd@botname suffix', () => {
    expect(parseCommand('/status@OpsBot')).toEqual({ ok: true, name: 'status', args: [] });
  });

  test('lowercases the command name', () => {
    expect(parseCommand('/HeLp')).toEqual({ ok: true, name: 'help', args: [] });
  });

  test('parses quoted arguments', () => {
    expect(parseCommand('/windows "Mac Mini"')).toEqual({
      ok: true,
      name: 'windows',
      args: ['Mac Mini'],
    });
  });

  test('parses --node targeting', () => {
    expect(parseCommand('/devices --node home')).toEqual({
      ok: true,
      name: 'devices',
      args: [],
      nodeTarget: 'home',
    });
  });

  test('parses a leading @node token', () => {
    expect(parseCommand('devices @office')).toEqual({
      ok: true,
      name: 'devices',
      args: [],
      nodeTarget: 'office',
    });
  });

  test('does not treat a later @token as node targeting', () => {
    expect(parseCommand('run laptop @not-a-node -- ls')).toEqual({
      ok: true,
      name: 'run',
      args: ['laptop', '@not-a-node'],
      tail: 'ls',
    });
  });

  test('parses -- tail as free-form text', () => {
    expect(parseCommand('/run local %1 -- echo "hello world"')).toEqual({
      ok: true,
      name: 'run',
      args: ['local', '%1'],
      tail: 'echo "hello world"',
    });
  });

  test('keeps tokens after -- unquoted as a single tail string', () => {
    expect(parseCommand('run dev 1.0 -- git status -sb')).toEqual({
      ok: true,
      name: 'run',
      args: ['dev', '1.0'],
      tail: 'git status -sb',
    });
  });

  test('combines @bot suffix, --node, and -- tail', () => {
    expect(parseCommand('/run@MyBot --node home "dev 1" %0 -- echo hi')).toEqual({
      ok: true,
      name: 'run',
      args: ['dev 1', '%0'],
      nodeTarget: 'home',
      tail: 'echo hi',
    });
  });

  test('returns empty for blank input', () => {
    expect(parseCommand('   ')).toEqual({ ok: false, error: 'empty' });
    expect(parseCommand('/')).toEqual({ ok: false, error: 'empty' });
  });

  test('returns invalid when --node has no value', () => {
    expect(parseCommand('/devices --node')).toEqual({ ok: false, error: 'invalid' });
  });

  test('returns invalid when --node is followed by --', () => {
    expect(parseCommand('/run --node -- echo')).toEqual({ ok: false, error: 'invalid' });
  });

  test('accepts extra whitespace', () => {
    expect(parseCommand('  /nodes   --node   abc  ')).toEqual({
      ok: true,
      name: 'nodes',
      args: [],
      nodeTarget: 'abc',
    });
  });

  test('empty quotes become empty-string args', () => {
    expect(parseCommand('/windows ""')).toEqual({ ok: true, name: 'windows', args: [''] });
  });

  test('leading @ after flags still counts as node targeting if no args yet', () => {
    expect(parseCommand('/status --node ignored @real')).toEqual({
      ok: true,
      name: 'status',
      args: [],
      nodeTarget: 'real',
    });
  });
});
