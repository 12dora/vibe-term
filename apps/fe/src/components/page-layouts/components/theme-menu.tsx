// 侧边栏主题选择菜单：Light / Dark 切站点外观（服务端同步），其余项为主题预设（本地持久化）。
// 两类取值共用一个 radio group，故预设 id 之外用 `appearance:` 前缀区分默认外观项。

import { useSiteStore, useUIStore } from '@tmex/stores/react';
import {
  THEME_PRESETS,
  THEME_PRESET_META,
  type ThemeAppearance,
  type ThemePreset,
  type ThemePresetMeta,
} from '@tmex/theme';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@tmex/ui/dropdown-menu';
import { Moon, Palette, Sun } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const APPEARANCE_VALUE_PREFIX = 'appearance:';

export type ThemeMenuValue = ThemePreset | `${typeof APPEARANCE_VALUE_PREFIX}${ThemeAppearance}`;

export interface ThemeMenuSelection {
  preset: ThemePreset | null;
  appearance?: ThemeAppearance;
}

export function themeMenuValue(
  preset: ThemePreset | null,
  appearance: ThemeAppearance
): ThemeMenuValue {
  return preset ?? `${APPEARANCE_VALUE_PREFIX}${appearance}`;
}

export function parseThemeMenuValue(value: unknown): ThemeMenuSelection | null {
  if (typeof value !== 'string') return null;
  if (value === `${APPEARANCE_VALUE_PREFIX}light`) return { preset: null, appearance: 'light' };
  if (value === `${APPEARANCE_VALUE_PREFIX}dark`) return { preset: null, appearance: 'dark' };
  const preset = THEME_PRESETS.find((id) => id === value);
  return preset ? { preset } : null;
}

export interface ThemeMenuViewProps {
  appearance: ThemeAppearance;
  preset: ThemePreset | null;
  onSelect: (preset: ThemePreset | null, fallbackAppearance?: ThemeAppearance) => void;
}

export function ThemeMenuView({ appearance, preset, onSelect }: ThemeMenuViewProps) {
  const { t } = useTranslation();

  const handleValueChange = (next: unknown): void => {
    const selection = parseThemeMenuValue(next);
    if (!selection) return;
    onSelect(selection.preset, selection.appearance);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-testid="theme-menu-trigger"
        data-theme-preset={preset ?? ''}
        data-theme-appearance={appearance}
        aria-label={t('settings.theme')}
        title={t('settings.theme')}
        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground data-popup-open:bg-sidebar-accent data-popup-open:text-foreground"
      >
        <Palette className="h-4 w-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        backdrop
        className="min-w-56 max-w-[80vw]"
        data-testid="theme-menu"
      >
        <DropdownMenuRadioGroup
          value={themeMenuValue(preset, appearance)}
          onValueChange={handleValueChange}
        >
          <DropdownMenuRadioItem
            value={`${APPEARANCE_VALUE_PREFIX}light`}
            closeOnClick
            data-testid="theme-option-light"
            className="py-2 [@media(any-pointer:coarse)]:py-2.5"
          >
            <Sun className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('settings.themeLight')}</span>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem
            value={`${APPEARANCE_VALUE_PREFIX}dark`}
            closeOnClick
            data-testid="theme-option-dark"
            className="py-2 [@media(any-pointer:coarse)]:py-2.5"
          >
            <Moon className="h-4 w-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{t('settings.themeDark')}</span>
          </DropdownMenuRadioItem>

          <DropdownMenuSeparator />

          {THEME_PRESETS.map((id) => {
            const meta = THEME_PRESET_META[id];
            return (
              <DropdownMenuRadioItem
                key={id}
                value={id}
                closeOnClick
                data-testid={`theme-option-${id}`}
                data-theme-appearance={meta.appearance}
                label={meta.label}
                className="py-2 [@media(any-pointer:coarse)]:py-2.5"
              >
                <ThemeSwatch preview={meta.preview} />
                <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                <span className="shrink-0 text-[10.5px] text-muted-foreground">
                  {meta.appearance === 'light' ? t('settings.themeLight') : t('settings.themeDark')}
                </span>
              </DropdownMenuRadioItem>
            );
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function ThemeSwatch({ preview }: { preview: ThemePresetMeta['preview'] }) {
  return (
    <span
      aria-hidden="true"
      className="flex h-4 w-4 shrink-0 overflow-hidden rounded-full ring-1 ring-foreground/20"
    >
      <span className="flex-1" style={{ backgroundColor: preview.background }} />
      <span className="flex-1" style={{ backgroundColor: preview.foreground }} />
      <span className="flex-1" style={{ backgroundColor: preview.accent }} />
    </span>
  );
}

export function ThemeMenu() {
  const appearance = useUIStore((state) => state.theme);
  const preset = useUIStore((state) => state.themePreset);
  const selectThemePreset = useSiteStore((state) => state.selectThemePreset);

  return <ThemeMenuView appearance={appearance} preset={preset} onSelect={selectThemePreset} />;
}
