import type { DeviceView, TmuxPaneView, TmuxWindowView } from './context';

export type RefResolveError = {
  ok: false;
  error: 'unknown' | 'ambiguous';
  input: string;
  candidates: string[];
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function only<T>(items: T[]): T | undefined {
  return items.length === 1 ? items[0] : undefined;
}

export function resolveDeviceRef(
  input: string,
  devices: DeviceView[]
): { ok: true; device: DeviceView } | RefResolveError {
  const exactId = devices.find((device) => device.id === input);
  if (exactId) return { ok: true, device: exactId };

  const needle = normalize(input);
  const nameMatches = devices.filter((device) => normalize(device.name) === needle);
  const nameMatch = only(nameMatches);
  if (nameMatch) return { ok: true, device: nameMatch };
  if (nameMatches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      input,
      candidates: nameMatches.map((device) => device.name),
    };
  }
  return { ok: false, error: 'unknown', input, candidates: [] };
}

const PANE_INDEX = /^(\d+)\.(\d+)$/;

function paneLabel(pane: TmuxPaneView): string {
  return `${pane.windowIndex}.${pane.index} (${pane.id})`;
}

function findByIndex(
  input: string,
  windows: TmuxWindowView[]
): { ok: true; pane: TmuxPaneView } | RefResolveError | null {
  const indexed = PANE_INDEX.exec(input);
  if (!indexed) return null;
  const windowIndex = Number(indexed[1]);
  const paneIndex = Number(indexed[2]);
  const matches: TmuxPaneView[] = [];
  for (const window of windows) {
    if (window.index !== windowIndex) continue;
    for (const pane of window.panes) {
      if (pane.index === paneIndex) matches.push(pane);
    }
  }
  const match = only(matches);
  if (match) return { ok: true, pane: match };
  if (matches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      input,
      candidates: matches.map(paneLabel),
    };
  }
  return { ok: false, error: 'unknown', input, candidates: [] };
}

export function resolvePaneRef(
  input: string,
  windows: TmuxWindowView[]
): { ok: true; pane: TmuxPaneView } | RefResolveError {
  const byIndex = findByIndex(input, windows);
  if (byIndex) return byIndex;

  const panes = windows.flatMap((window) => window.panes);
  const idMatches = panes.filter((pane) => pane.id === input);
  const idMatch = only(idMatches);
  if (idMatch) return { ok: true, pane: idMatch };
  if (idMatches.length > 1) {
    return { ok: false, error: 'ambiguous', input, candidates: idMatches.map(paneLabel) };
  }
  return { ok: false, error: 'unknown', input, candidates: [] };
}

export function findWindow(
  input: string | undefined,
  windows: TmuxWindowView[]
): { ok: true; window: TmuxWindowView } | RefResolveError | { ok: true; window: null } {
  if (!input) return { ok: true, window: null };
  const byId = windows.find((window) => window.id === input);
  if (byId) return { ok: true, window: byId };
  if (/^\d+$/.test(input)) {
    const index = Number(input);
    const matches = windows.filter((window) => window.index === index);
    const match = only(matches);
    if (match) return { ok: true, window: match };
    if (matches.length > 1) {
      return {
        ok: false,
        error: 'ambiguous',
        input,
        candidates: matches.map((window) => window.name || window.id),
      };
    }
  }
  const needle = normalize(input);
  const nameMatches = windows.filter((window) => normalize(window.name) === needle);
  const nameMatch = only(nameMatches);
  if (nameMatch) return { ok: true, window: nameMatch };
  if (nameMatches.length > 1) {
    return {
      ok: false,
      error: 'ambiguous',
      input,
      candidates: nameMatches.map((window) => window.name || window.id),
    };
  }
  return { ok: false, error: 'unknown', input, candidates: [] };
}
