import { describe, expect, it } from 'bun:test';
import type { DestContext } from './dest';
import { buildWalkCommand, parseWalkOutput } from './dest-remote';

const enc = (s: string) => new TextEncoder().encode(s);

function fakeCtx(): DestContext {
  return {
    root: { path: '/srv/root' },
    destDir: '/srv/root/dest',
  } as DestContext;
}

describe('parseWalkOutput', () => {
  it('绝对路径与已存在标记按标记长度切片，不丢字符', () => {
    expect(parseWalkOutput(enc('VTDIR /srv/uploads\nVTEXISTS 1\n'))).toEqual({
      dir: '/srv/uploads',
      exists: true,
    });
  });

  it('不存在标记为 0，且容忍 CRLF', () => {
    expect(parseWalkOutput(enc('VTDIR /home/u/dir\r\nVTEXISTS 0\r\n'))).toEqual({
      dir: '/home/u/dir',
      exists: false,
    });
  });

  it('缺任一标记时返回 null', () => {
    expect(parseWalkOutput(enc('VTDIR /x\n'))).toBeNull();
    expect(parseWalkOutput(enc('garbage\n'))).toBeNull();
  });
});

describe('buildWalkCommand', () => {
  it('creates missing segments with mode 0755 and rmdir on containment failure', () => {
    const cmd = buildWalkCommand(fakeCtx(), ['a', 'b'], 'file.txt');
    expect(cmd).toContain('mkdir -m 0755 -- "$s"');
    expect(cmd).not.toContain('mkdir -- "$s"');
    expect(cmd).toContain('rmdir -- "$s"');
    expect(cmd).toContain('exit 66');
  });
});
