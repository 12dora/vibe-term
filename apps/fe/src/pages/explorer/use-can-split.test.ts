import { describe, expect, test } from 'bun:test';
import { EXPLORER_MAX_PANES } from '@vibeterm/stores/explorer';

import { canSplitWorkspace } from './use-can-split';

describe('canSplitWorkspace', () => {
  test('allowed on a wide layout with a tab and room for another pane', () => {
    expect(canSplitWorkspace({ paneCount: 1, narrow: false, hasTab: true })).toBe(true);
    expect(
      canSplitWorkspace({ paneCount: EXPLORER_MAX_PANES - 1, narrow: false, hasTab: true })
    ).toBe(true);
  });

  test('refused at the pane limit', () => {
    expect(canSplitWorkspace({ paneCount: EXPLORER_MAX_PANES, narrow: false, hasTab: true })).toBe(
      false
    );
  });

  test('refused on narrow layouts', () => {
    expect(canSplitWorkspace({ paneCount: 1, narrow: true, hasTab: true })).toBe(false);
  });

  test('refused without any tab', () => {
    expect(canSplitWorkspace({ paneCount: 1, narrow: false, hasTab: false })).toBe(false);
  });
});
