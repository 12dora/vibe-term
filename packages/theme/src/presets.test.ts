import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { TERMINAL_THEME_DARK, TERMINAL_THEME_LIGHT } from '@tmex/shared';
import { contrastRatio } from './color-utils';
import { extractPresetSection, renderPresetCssSections } from './preset-css';
import { THEME_PRESET_META, resolveTerminalTheme } from './preset-meta';
import { PRESET_PALETTES } from './preset-palettes';
import { THEME_PRESETS, isThemePreset } from './presets';
import { TERMINAL_SHORTCUT_TOKENS } from './terminal-shortcut-tokens';

const themeSrc = import.meta.dir;
const themesCss = fs.readFileSync(path.join(themeSrc, 'themes.css'), 'utf8');
const tokensCss = fs.readFileSync(path.join(themeSrc, 'tokens.css'), 'utf8');
const hljsCss = fs.readFileSync(
  path.join(themeSrc, '../../panels/src/code-viewer/hljs-terminal-theme.css'),
  'utf8'
);

/** tokens.css 的 :root 声明的全部语义 token（去掉 base ramp / safe-area / 字体等非配色项） */
function semanticTokensFromRoot(): string[] {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(tokensCss);
  if (!root) throw new Error('tokens.css :root not found');
  return [...root[1].matchAll(/^\s*(--[a-z0-9-]+):/gm)]
    .map((m) => m[1])
    .filter(
      (name) =>
        !name.startsWith('--base-') &&
        !name.startsWith('--tmex-') &&
        name !== '--radius' &&
        name !== '--display-weight'
    );
}

function presetBlock(css: string, id: string): string {
  const re = new RegExp(`\\[data-theme-preset="${id}"\\]\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  if (!m) throw new Error(`preset block not found: ${id}`);
  return m[1];
}

function declaredVars(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()])
  );
}

describe('THEME_PRESETS', () => {
  test('注册表与 themes.css 的 data-theme-preset 名单一致', () => {
    const inCss = new Set(
      [...themesCss.matchAll(/data-theme-preset="([a-z-]+)"/g)].map((m) => m[1])
    );
    expect(new Set(THEME_PRESETS)).toEqual(inCss);
  });

  test('注册表与 hljs-terminal-theme.css 的 data-theme-preset 名单一致', () => {
    const inCss = new Set([...hljsCss.matchAll(/data-theme-preset="([a-z-]+)"/g)].map((m) => m[1]));
    expect(new Set(THEME_PRESETS)).toEqual(inCss);
  });

  test('isThemePreset 判定', () => {
    expect(isThemePreset('dracula')).toBe(true);
    expect(isThemePreset('github-light')).toBe(true);
    expect(isThemePreset('underground')).toBe(false);
    expect(isThemePreset('not-a-preset')).toBe(false);
    expect(isThemePreset(null)).toBe(false);
  });

  test('id 无重复', () => {
    expect(new Set(THEME_PRESETS).size).toBe(THEME_PRESETS.length);
  });
});

describe('生成产物与调色板真源一致', () => {
  test('themes.css / hljs-terminal-theme.css 未过期（改完请跑 bun scripts/theme/build-theme-presets.ts）', () => {
    const sections = renderPresetCssSections();
    expect(extractPresetSection(themesCss)).toBe(sections.themes);
    expect(extractPresetSection(hljsCss)).toBe(sections.hljs);
  });
});

describe('每个预设覆盖完整语义 token', () => {
  const semantic = semanticTokensFromRoot();

  test('tokens.css :root 的语义 token 名单非空且含关键项', () => {
    expect(semantic).toContain('--background');
    expect(semantic).toContain('--sidebar-ring');
    expect(semantic).toContain('--chat-surface');
    expect(semantic).toContain('--fc-today-bg-color');
  });

  for (const id of THEME_PRESETS) {
    test(`${id} 定义全部语义 token`, () => {
      const vars = declaredVars(presetBlock(themesCss, id));
      for (const name of semantic) {
        expect(vars.has(name)).toBe(true);
      }
    });
  }

  for (const id of THEME_PRESETS) {
    test(`${id} 定义全部 --code-* token`, () => {
      const base = declaredVars(/:root\s*\{([\s\S]*?)\n\}/.exec(hljsCss)?.[1] ?? '');
      const vars = declaredVars(presetBlock(hljsCss, id));
      for (const name of base.keys()) {
        expect(vars.has(name)).toBe(true);
      }
    });
  }
});

describe('THEME_PRESET_META', () => {
  test('覆盖全部预设且 id 自洽', () => {
    expect(Object.keys(THEME_PRESET_META).sort()).toEqual([...THEME_PRESETS].sort());
    for (const id of THEME_PRESETS) {
      expect(THEME_PRESET_META[id].id).toBe(id);
    }
  });

  test('label 为英文品牌名，appearance 合法', () => {
    for (const id of THEME_PRESETS) {
      const meta = THEME_PRESET_META[id];
      expect(meta.label).toMatch(/^[A-Za-z][A-Za-z0-9 ]*$/);
      expect(['light', 'dark']).toContain(meta.appearance);
    }
  });

  test('preview 三色为 hex，background 取自 UI --background', () => {
    for (const id of THEME_PRESETS) {
      const { preview } = THEME_PRESET_META[id];
      for (const value of [preview.background, preview.foreground, preview.accent]) {
        expect(value).toMatch(/^#[0-9a-f]{6}$/);
      }
      const vars = declaredVars(presetBlock(themesCss, id));
      expect(preview.background).toBe(vars.get('--background'));
      expect(preview.foreground).toBe(vars.get('--foreground'));
      expect(preview.accent).toBe(vars.get('--primary'));
    }
  });

  test('appearance 与背景明暗自洽（深色预设背景暗于前景）', () => {
    for (const id of THEME_PRESETS) {
      const meta = THEME_PRESET_META[id];
      const bgLighterThanFg =
        contrastRatio(meta.preview.background, '#ffffff') <
        contrastRatio(meta.preview.foreground, '#ffffff');
      expect(bgLighterThanFg).toBe(meta.appearance === 'light');
    }
  });

  // 抄调色板时最容易把 bright 槽整段复制成 normal 槽（tokyo-night-light 曾如此），
  // 结果 ANSI 90-97 与 30-37 无法区分。Catppuccin 上游官方配色本就 1-6 与 9-14 同色，单独放行。
  const MIRRORED_BRIGHT_PRESETS = new Set<string>(['catppuccin-mocha', 'catppuccin-latte']);

  test('bright 六色不整体复制 normal 槽', () => {
    const slots = ['Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan'] as const;
    for (const id of THEME_PRESETS) {
      if (MIRRORED_BRIGHT_PRESETS.has(id)) continue;
      const terminal = THEME_PRESET_META[id].terminal as unknown as Record<string, string>;
      const duplicated = slots.filter(
        (slot) => terminal[`bright${slot}`] === terminal[slot.toLowerCase()]
      );
      expect([id, duplicated.length < slots.length]).toEqual([id, true]);
    }
  });

  test('tokyo-night-light 的 bright 槽取自上游 tokyonight_day', () => {
    const { terminal } = THEME_PRESET_META['tokyo-night-light'];
    expect({
      brightRed: terminal.brightRed,
      brightGreen: terminal.brightGreen,
      brightYellow: terminal.brightYellow,
      brightBlue: terminal.brightBlue,
      brightMagenta: terminal.brightMagenta,
      brightCyan: terminal.brightCyan,
    }).toEqual({
      brightRed: '#ff4774',
      brightGreen: '#5c8524',
      brightYellow: '#a27629',
      brightBlue: '#358aff',
      brightMagenta: '#a463ff',
      brightCyan: '#007ea8',
    });
  });

  test('terminal 为完整 16 色 + fg/bg/cursor/selection', () => {
    const keys = Object.keys(TERMINAL_THEME_DARK);
    for (const id of THEME_PRESETS) {
      const terminal = THEME_PRESET_META[id].terminal as unknown as Record<string, string>;
      expect(Object.keys(terminal).sort()).toEqual([...keys].sort());
      for (const key of keys) {
        if (key === 'selectionBackground') continue;
        expect(terminal[key]).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });
});

describe('resolveTerminalTheme', () => {
  test('无预设时回落到站点外观对应的 seoul256', () => {
    expect(resolveTerminalTheme('light', null)).toBe(TERMINAL_THEME_LIGHT);
    expect(resolveTerminalTheme('dark', null)).toBe(TERMINAL_THEME_DARK);
  });

  test('有预设时预设优先，与外观参数无关', () => {
    for (const id of THEME_PRESETS) {
      const expected = THEME_PRESET_META[id].terminal;
      expect(resolveTerminalTheme('light', id)).toBe(expected);
      expect(resolveTerminalTheme('dark', id)).toBe(expected);
    }
  });
});

describe('可读性', () => {
  test('前景/背景达到 AA(4.5)，卡片、侧栏、muted、accent 同样成立', () => {
    for (const id of THEME_PRESETS) {
      const { ui } = PRESET_PALETTES[id];
      for (const surface of [
        ui.background,
        ui.surface,
        ui.sidebar,
        ui.muted,
        ui.accent,
        ui.chatSurface,
      ]) {
        expect(contrastRatio(ui.foreground, surface)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test('muted-foreground 对背景达 AA，对 muted/sidebar 不低于 4.0', () => {
    for (const id of THEME_PRESETS) {
      const { ui } = PRESET_PALETTES[id];
      expect(contrastRatio(ui.subtle, ui.background)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.subtle, ui.muted)).toBeGreaterThanOrEqual(4);
      expect(contrastRatio(ui.subtle, ui.sidebar)).toBeGreaterThanOrEqual(4);
    }
  });

  test('primary/secondary 能承载各自前景色（AA）', () => {
    for (const id of THEME_PRESETS) {
      const { ui } = PRESET_PALETTES[id];
      expect(contrastRatio(ui.primaryForeground, ui.primary)).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(ui.secondaryForeground, ui.secondary)).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('边框可见、primary/destructive 从背景中跳出', () => {
    for (const id of THEME_PRESETS) {
      const { ui } = PRESET_PALETTES[id];
      expect(contrastRatio(ui.border, ui.background)).toBeGreaterThanOrEqual(1.2);
      expect(contrastRatio(ui.input, ui.background)).toBeGreaterThanOrEqual(1.5);
      expect(contrastRatio(ui.primary, ui.background)).toBeGreaterThanOrEqual(3);
      expect(contrastRatio(ui.destructive, ui.background)).toBeGreaterThanOrEqual(3);
      for (const chart of ui.charts) {
        expect(contrastRatio(chart, ui.background)).toBeGreaterThanOrEqual(2.2);
      }
    }
  });

  test('代码高亮各 token 对代码底色不低于 4.0', () => {
    for (const id of THEME_PRESETS) {
      const vars = declaredVars(presetBlock(hljsCss, id));
      const bg = vars.get('--code-bg');
      expect(bg).toBeDefined();
      for (const [name, value] of vars) {
        if (name === '--code-bg') continue;
        expect(contrastRatio(value, bg as string)).toBeGreaterThanOrEqual(4);
      }
    }
  });
});

describe('terminal shortcut tokens', () => {
  test('tokens.generated.css 与 TS 真源一致（重新生成后须复跑）', () => {
    const css = fs.readFileSync(path.join(themeSrc, 'tokens.generated.css'), 'utf8');
    expect(css).toContain(`--terminal-shortcut-fg: ${TERMINAL_SHORTCUT_TOKENS.light.fg};`);
    expect(css).toContain(`--terminal-shortcut-bg: ${TERMINAL_SHORTCUT_TOKENS.light.bg};`);
    expect(css).toContain(`--terminal-shortcut-fg: ${TERMINAL_SHORTCUT_TOKENS.dark.fg};`);
    expect(css).toContain(`--terminal-shortcut-bg: ${TERMINAL_SHORTCUT_TOKENS.dark.bg};`);
  });
});
