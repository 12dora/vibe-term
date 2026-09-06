import { describe, expect, it } from 'bun:test';
import { parseWalkOutput } from './dest-remote';

const enc = (s: string) => new TextEncoder().encode(s);

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
