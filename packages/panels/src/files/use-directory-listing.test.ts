import { describe, expect, test } from 'bun:test';
import { installWindowStorage } from '@vibeterm/stores/test-utils';
import { DIRECTORY_LISTING_REFETCH_ON_WINDOW_FOCUS } from './use-directory-listing';

installWindowStorage();

describe('useDirectoryListing 回前台策略', () => {
  test('不在窗口聚焦时重拉，靠 30s 轮询与 SETTINGS_UPDATE', () => {
    expect(DIRECTORY_LISTING_REFETCH_ON_WINDOW_FOCUS).toBe(false);
  });
});
