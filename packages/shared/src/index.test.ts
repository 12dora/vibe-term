// @tmex/shared 主入口的运行时导出面锁定
//
// index.ts 是全仓库的公共契约入口，任何包都从 '@tmex/shared' 消费它。
// 拆分/重排模块时若漏掉一条 re-export，类型侧未必立刻报错，但运行时值会静默消失。
// 这里把运行时导出名快照下来，少一个或多一个都要显式改这张表。

import { describe, expect, it } from 'bun:test';

const EXPECTED_RUNTIME_EXPORTS = [
  'API_VERSION',
  'BRAND_LOGO_SRC',
  'DEFAULT_AGENT_SESSION_TITLE',
  'DEFAULT_LOCALE',
  'DEFAULT_TERMINAL_SHORTCUTS',
  'DEFERRED_CLIPBOARD_TTL_MS',
  'DEVICE_FOLDER_NAME_MAX_LENGTH',
  'DEVICE_FOLDER_SELF_NODE_ID',
  'EMPTY_PANE_MODE_FLAGS',
  'GATEWAY_CAPABILITIES',
  'GATEWAY_CAPABILITY_CANONICAL_STATE_V1',
  'GATEWAY_CAPABILITY_CANONICAL_STATE_V1_1',
  'I18N_MANIFEST',
  'I18N_RESOURCES',
  'INSTALL_COMMAND',
  'INSTALL_SCRIPT_URL',
  'MIN_TMUX_VERSION',
  'PANE_MODE_ALT_SCREEN',
  'PANE_MODE_FLAGS_PRESENT',
  'PRODUCT_NAME',
  'RELEASE_API_LATEST_URL',
  'RELEASE_REPO',
  'RELEASE_REPO_URL',
  'SUPPORTED_LOCALES',
  'TERMINAL_SHORTCUT_ACTIONS',
  'TERMINAL_THEME_DARK',
  'TERMINAL_THEME_LIGHT',
  'UPGRADE_CANCELLED',
  'b',
  'basename',
  'collectLayoutLeaves',
  'combineAbortSignals',
  'compareSemver',
  'compareSemverRequired',
  'compareTmuxVersion',
  'countFolderItems',
  'createDeferredClipboardWriter',
  'decodePaneModes',
  'deviceFolderPlacementKey',
  'dirname',
  'encodePaneModes',
  'findNodeFolderId',
  'formatBytes',
  'formatBytesPair',
  'formatDate',
  'formatDateTime',
  'formatDisplayVersion',
  'formatHttpEndpoint',
  'formatRate',
  'getOsc11ResponseColor',
  'getTerminalTheme',
  'getTmuxWindowStyle',
  'isDeviceFolderLayoutValid',
  'isFolderListValid',
  'isStandaloneRoles',
  'isTmexRoleName',
  'layoutLeafPaneId',
  'moveFolderInLayout',
  'moveNodeInLayout',
  'normalizeDeviceFolderName',
  'normalizeFolderLayoutOrder',
  'normalizePosixPath',
  'parseSemver',
  'parseTmuxVersion',
  'parseWindowLayout',
  'releaseApiUrl',
  'releaseTag',
  'releaseTarballName',
  'releaseTarballUrl',
  'removeNodeFromLayout',
  'reparentOnFolderDelete',
  'requireSemver',
  'rewriteWildcardBindHost',
  'roleNameFromFlags',
  'rolesFromName',
  'toBCP47',
  'validateDeviceFolderName',
  'validateRoles',
  'withTimeout',
  'writeTextToClipboard',
  'wsBorsh',
];

describe('@tmex/shared 主入口', () => {
  it('运行时导出面与快照一致', async () => {
    const mod = await import('./index');
    expect(Object.keys(mod).sort()).toEqual(EXPECTED_RUNTIME_EXPORTS);
  });

  it('转换层经 wsBorsh 命名空间可用', async () => {
    const { wsBorsh } = await import('./index');
    expect(typeof wsBorsh.encodeTmuxEventPayload).toBe('function');
    expect(typeof wsBorsh.decodeTmuxEventPayload).toBe('function');
  });
});
