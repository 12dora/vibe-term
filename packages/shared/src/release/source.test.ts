// 发行资产名的新旧双接受与推包选名

import { describe, expect, it } from 'bun:test';
import {
  INSTALL_COMMAND,
  INSTALL_SCRIPT_URL,
  RELEASE_REPO,
  isReleaseTarballName,
  legacyReleaseTarballName,
  legacyReleaseTarballUrl,
  parseReleaseTarballName,
  releaseTarballName,
  releaseTarballUrl,
  selectReleaseAssetForTarget,
} from './source';

describe('发行来源常量', () => {
  it('指向改名后的仓库', () => {
    expect(RELEASE_REPO).toBe('12dora/vibe-term');
    expect(INSTALL_SCRIPT_URL).toBe(
      'https://raw.githubusercontent.com/12dora/vibe-term/main/install.sh'
    );
    expect(INSTALL_COMMAND).toContain('12dora/vibe-term');
  });
});

describe('资产名', () => {
  it('新旧名与对应下载地址', () => {
    expect(releaseTarballName('2.0.0')).toBe('vibeterm-cli-2.0.0.tgz');
    expect(legacyReleaseTarballName('2.0.0')).toBe('tmex-cli-2.0.0.tgz');
    expect(releaseTarballUrl('2.0.0')).toBe(
      'https://github.com/12dora/vibe-term/releases/download/v2.0.0/vibeterm-cli-2.0.0.tgz'
    );
    expect(legacyReleaseTarballUrl('2.0.0')).toBe(
      'https://github.com/12dora/vibe-term/releases/download/v2.0.0/tmex-cli-2.0.0.tgz'
    );
  });

  it('识别并解析两种资产名', () => {
    expect(isReleaseTarballName('vibeterm-cli-2.0.0.tgz')).toBe(true);
    expect(isReleaseTarballName('tmex-cli-1.1.40.tgz')).toBe(true);
    expect(parseReleaseTarballName('vibeterm-cli-2.0.0.tgz')).toBe('2.0.0');
    expect(parseReleaseTarballName('tmex-cli-1.1.40.tgz')).toBe('1.1.40');
    expect(parseReleaseTarballName('vibeterm-cli-2.0.0-rc.1.tgz')).toBe('2.0.0-rc.1');
  });

  it('拒绝无关文件名', () => {
    expect(isReleaseTarballName('SHA256SUMS')).toBe(false);
    expect(isReleaseTarballName('vibeterm-cli-2.0.0.tgz.part')).toBe(false);
    expect(isReleaseTarballName('other-cli-2.0.0.tgz')).toBe(false);
    expect(parseReleaseTarballName('dist/vibeterm-cli-2.0.0.tgz')).toBeNull();
  });
});

describe('selectReleaseAssetForTarget', () => {
  it('目标节点低于 2.0.0 时用旧资产名', () => {
    expect(selectReleaseAssetForTarget('1.1.40', '2.0.0')).toBe('tmex-cli-2.0.0.tgz');
    expect(selectReleaseAssetForTarget('1.0.0', '2.0.1')).toBe('tmex-cli-2.0.1.tgz');
  });

  it('目标节点 ≥ 2.0.0 时用新资产名', () => {
    expect(selectReleaseAssetForTarget('2.0.0', '2.0.0')).toBe('vibeterm-cli-2.0.0.tgz');
    expect(selectReleaseAssetForTarget('2.1.3', '2.2.0')).toBe('vibeterm-cli-2.2.0.tgz');
  });

  it('版本未知或不可解析时保守用旧资产名', () => {
    expect(selectReleaseAssetForTarget(null, '2.0.0')).toBe('tmex-cli-2.0.0.tgz');
    expect(selectReleaseAssetForTarget(undefined, '2.0.0')).toBe('tmex-cli-2.0.0.tgz');
    expect(selectReleaseAssetForTarget('2.0.0_dev', '2.0.0')).toBe('tmex-cli-2.0.0.tgz');
  });
});
