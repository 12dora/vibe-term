import { describe, expect, test } from 'bun:test';

import { cleanTerminalText } from './run-command-text';

describe('cleanTerminalText', () => {
  test('drops OSC 8 hyperlinks terminated by ST or BEL and keeps the label', () => {
    expect(
      cleanTerminalText('open \x1b]8;id=a1;https://example.com/a?b=1\x1b\\docs\x1b]8;;\x1b\\ now')
    ).toBe('open docs now');
    expect(cleanTerminalText('\x1b]8;;https://example.com\x07x\x1b]8;;\x07')).toBe('x');
  });
});
