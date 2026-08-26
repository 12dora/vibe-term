import { z } from 'zod';

export const SEND_INPUT_KEYS = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'up',
  'down',
  'left',
  'right',
  'ctrl_c',
  'ctrl_d',
  'ctrl_z',
  'ctrl_l',
  'ctrl_u',
] as const;

export type SendInputKey = (typeof SEND_INPUT_KEYS)[number];

export const KEY_SEQUENCES: Record<SendInputKey, string> = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  ctrl_c: '\x03',
  ctrl_d: '\x04',
  ctrl_z: '\x1a',
  ctrl_l: '\x0c',
  ctrl_u: '\x15',
};

export function encodeKeysToSequence(keys: readonly SendInputKey[]): string {
  return keys.map((key) => KEY_SEQUENCES[key]).join('');
}

export const SEND_INPUT_MODIFIERS = ['ctrl', 'alt', 'meta', 'shift'] as const;
export type SendInputModifier = (typeof SEND_INPUT_MODIFIERS)[number];

const COMBO_LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');
const COMBO_DIGITS = '0123456789'.split('');
const COMBO_SYMBOLS = '!@#$%^&*()-_=+[]{}|;:\'",.<>/?`~'.split('');
const COMBO_SPECIAL_KEYS = [
  'enter',
  'tab',
  'escape',
  'backspace',
  'space',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
  'insert',
  'delete',
  'f1',
  'f2',
  'f3',
  'f4',
  'f5',
  'f6',
  'f7',
  'f8',
  'f9',
  'f10',
  'f11',
  'f12',
];
const COMBO_KEYS = [
  ...COMBO_LETTERS,
  ...COMBO_DIGITS,
  ...COMBO_SYMBOLS,
  ...COMBO_SPECIAL_KEYS,
] as const;

export const COMBO_KEY_ENUM = z.enum(COMBO_KEYS);
export type ComboKey = (typeof COMBO_KEYS)[number];

const COMBO_SPECIAL_SEQUENCES: Record<string, string> = {
  enter: '\r',
  tab: '\t',
  escape: '\x1b',
  backspace: '\x7f',
  space: ' ',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  home: '\x1b[H',
  end: '\x1b[F',
  pageup: '\x1b[5~',
  pagedown: '\x1b[6~',
  insert: '\x1b[2~',
  delete: '\x1b[3~',
  f1: '\x1bOP',
  f2: '\x1bOQ',
  f3: '\x1bOR',
  f4: '\x1bOS',
  f5: '\x1b[15~',
  f6: '\x1b[17~',
  f7: '\x1b[18~',
  f8: '\x1b[19~',
  f9: '\x1b[20~',
  f10: '\x1b[21~',
  f11: '\x1b[23~',
  f12: '\x1b[24~',
};

/** 把 modifier+key 组合编码为字节序列。Ctrl+字母用 control code；Alt/Meta 加 ESC 前缀；Shift+字母转大写。 */
export function encodeCombo(combo: {
  modifiers?: readonly SendInputModifier[];
  key: string;
}): string {
  const mods = new Set(combo.modifiers ?? []);
  const hasCtrl = mods.has('ctrl');
  const hasAlt = mods.has('alt');
  const hasMeta = mods.has('meta');
  const hasShift = mods.has('shift');
  const key = combo.key;

  const special = COMBO_SPECIAL_SEQUENCES[key];
  if (special !== undefined) {
    if (hasAlt || hasMeta) {
      return `\x1b${special}`;
    }
    return special;
  }

  let ch = key;
  if (key.length === 1) {
    if (hasCtrl && key >= 'a' && key <= 'z') {
      ch = String.fromCharCode(key.charCodeAt(0) & 0x1f);
    } else if (hasShift && key >= 'a' && key <= 'z') {
      ch = key.toUpperCase();
    }
  }
  const prefix = hasAlt || hasMeta ? '\x1b' : '';
  return `${prefix}${ch}`;
}
