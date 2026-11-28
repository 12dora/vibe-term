// 链接打开策略全表：hit × trigger × mouseReporting × 修饰键，逐格钉住 POLICY「Activation」「Hover」；
// 另钉住修饰键分类（平台主修饰键 vs Alt / 非平台 Ctrl、Meta）。
import { afterEach, describe, expect, test } from 'bun:test';
import {
  type LinkModifiers,
  type LinkOpenTrigger,
  NO_LINK_MODIFIERS,
  classifyLinkModifiers,
  shouldOpenLink,
} from './link-open-policy';
import type { TerminalLinkHit } from './terminal-pointer-shared';

const EXPLICIT: TerminalLinkHit = { kind: 'url', url: 'https://example.com', explicit: true };
const DETECTED: TerminalLinkHit = { kind: 'url', url: 'https://example.com', explicit: false };
const DETECTED_FILE: TerminalLinkHit = { kind: 'file', path: '/repo/a.ts', explicit: false };

const PLATFORM: LinkModifiers = { platform: true, other: false, shift: false };
const OTHER: LinkModifiers = { platform: false, other: true, shift: false };
const SHIFT: LinkModifiers = { platform: false, other: false, shift: true };
const PLATFORM_SHIFT: LinkModifiers = { platform: true, other: false, shift: true };
const PLATFORM_OTHER: LinkModifiers = { platform: true, other: true, shift: false };

const TRIGGERS: LinkOpenTrigger[] = ['press', 'release', 'hover', 'tap'];
const HITS: Array<[string, TerminalLinkHit]> = [
  ['explicit', EXPLICIT],
  ['detected', DETECTED],
  ['detected file', DETECTED_FILE],
];

// 无修饰：press 从不打开；release / hover / tap 上报关闭时都打开，上报开启时只开 explicit。
function expectedPlain(trigger: LinkOpenTrigger, hit: TerminalLinkHit, reporting: boolean) {
  return trigger !== 'press' && (!reporting || hit.explicit);
}

// 平台修饰键：press / hover 恒打开；release 不打开（已在按下时打开）；tap 不看修饰键。
function expectedPlatform(trigger: LinkOpenTrigger, hit: TerminalLinkHit, reporting: boolean) {
  if (trigger === 'press' || trigger === 'hover') {
    return true;
  }
  return trigger === 'tap' && (!reporting || hit.explicit);
}

describe('shouldOpenLink', () => {
  for (const trigger of TRIGGERS) {
    for (const mouseReporting of [false, true]) {
      const label = `${trigger} 上报=${mouseReporting}`;

      test(`无命中恒不打开：${label}`, () => {
        for (const modifiers of [NO_LINK_MODIFIERS, PLATFORM]) {
          expect(shouldOpenLink({ hit: null, trigger, mouseReporting, modifiers })).toBe(false);
        }
      });

      for (const [name, hit] of HITS) {
        test(`${name} ${label}`, () => {
          const input = { hit, trigger, mouseReporting };
          expect(shouldOpenLink({ ...input, modifiers: NO_LINK_MODIFIERS })).toBe(
            expectedPlain(trigger, hit, mouseReporting)
          );
          expect(shouldOpenLink({ ...input, modifiers: PLATFORM })).toBe(
            expectedPlatform(trigger, hit, mouseReporting)
          );
          for (const modifiers of [OTHER, SHIFT, PLATFORM_SHIFT, PLATFORM_OTHER]) {
            expect(shouldOpenLink({ ...input, modifiers })).toBe(false);
          }
        });
      }
    }
  }
});

describe('classifyLinkModifiers', () => {
  const navigatorHolder = globalThis as unknown as { navigator?: unknown };
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

  function setPlatform(platform: string): void {
    Object.defineProperty(navigatorHolder, 'navigator', {
      value: { platform },
      configurable: true,
      writable: true,
    });
  }

  afterEach(() => {
    if (savedNavigator) {
      Object.defineProperty(globalThis, 'navigator', savedNavigator);
    } else {
      delete navigatorHolder.navigator;
    }
  });

  const keys = (init: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey', boolean>>) => ({
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    ...init,
  });

  test('Mac：Cmd 是平台键，Ctrl / Alt 是其它修饰键，Alt+Cmd 不算平台键', () => {
    setPlatform('MacIntel');
    expect(classifyLinkModifiers(keys({ metaKey: true }))).toEqual(PLATFORM);
    expect(classifyLinkModifiers(keys({ ctrlKey: true }))).toEqual(OTHER);
    expect(classifyLinkModifiers(keys({ altKey: true }))).toEqual(OTHER);
    expect(classifyLinkModifiers(keys({ altKey: true, metaKey: true }))).toEqual(OTHER);
    expect(classifyLinkModifiers(keys({ shiftKey: true }))).toEqual(SHIFT);
  });

  test('其它平台：Ctrl 是平台键，Meta / Alt 是其它修饰键', () => {
    setPlatform('Linux x86_64');
    expect(classifyLinkModifiers(keys({ ctrlKey: true }))).toEqual(PLATFORM);
    expect(classifyLinkModifiers(keys({ metaKey: true }))).toEqual(OTHER);
    expect(classifyLinkModifiers(keys({ altKey: true, ctrlKey: true }))).toEqual(OTHER);
    expect(classifyLinkModifiers(keys({}))).toEqual(NO_LINK_MODIFIERS);
  });
});
