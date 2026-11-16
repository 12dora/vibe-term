import { describe, expect, test } from 'bun:test';
import { libcDlopenCandidates, openLibc } from './libc';

describe('libc dlopen candidates', () => {
  test('Linux tries glibc then musl so names for both amd64 and arm64', () => {
    expect(libcDlopenCandidates('linux', 'x64')).toEqual([
      'libc.so.6',
      'libc.so',
      'libc.musl-x86_64.so.1',
    ]);
    expect(libcDlopenCandidates('linux', 'arm64')).toEqual([
      'libc.so.6',
      'libc.so',
      'libc.musl-aarch64.so.1',
    ]);
  });

  test('macOS only opens libSystem', () => {
    expect(libcDlopenCandidates('darwin', 'arm64')).toEqual(['/usr/lib/libSystem.B.dylib']);
    expect(libcDlopenCandidates('darwin', 'x64')).toEqual(['/usr/lib/libSystem.B.dylib']);
  });

  test('openLibc returns a lib or null and never throws', () => {
    expect(() =>
      openLibc((t) => ({ dup2: { args: [t.i32, t.i32], returns: t.i32 } }))
    ).not.toThrow();
    const lib = openLibc((t) => ({ dup2: { args: [t.i32, t.i32], returns: t.i32 } }));
    expect(lib === null || typeof lib.symbols.dup2 === 'function').toBe(true);
  });
});
