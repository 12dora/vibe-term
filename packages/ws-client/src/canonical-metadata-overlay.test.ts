import { describe, expect, test } from 'bun:test';
import type { StateSnapshotPayload, TmuxWindow } from '@tmex/shared';
import { CanonicalMetadataOverlay } from './canonical-metadata-overlay';

function window(id: string, panes: string[]): TmuxWindow {
  return {
    id,
    name: id,
    index: 0,
    active: false,
    panes: panes.map((paneId) => ({
      id: paneId,
      windowId: id,
      index: 0,
      active: false,
      width: 80,
      height: 24,
    })),
  };
}

function snapshot(windows: TmuxWindow[]): StateSnapshotPayload {
  return { deviceId: 'device-a', session: { id: '$1', name: 'main', windows } };
}

describe('CanonicalMetadataOverlay', () => {
  test('preserves the legacy persisted window and pane order over canonical metadata', () => {
    const overlay = new CanonicalMetadataOverlay();
    overlay.capture(snapshot([window('@2', ['%3', '%2']), window('@1', ['%1'])]));

    const applied = overlay.apply(
      snapshot([window('@1', ['%1']), window('@2', ['%2', '%3', '%4']), window('@3', ['%5'])])
    );

    expect(applied.session?.windows.map((item) => item.id)).toEqual(['@2', '@1', '@3']);
    expect(applied.session?.windows[0]?.panes.map((item) => item.id)).toEqual(['%3', '%2', '%4']);
  });

  test('preserves custom names from the legacy overlay and clears stale canonical names', () => {
    const overlay = new CanonicalMetadataOverlay();
    const legacy = snapshot([window('@1', ['%1', '%2'])]);
    if (!legacy.session) throw new Error('missing session');
    legacy.session.windows[0]!.customName = 'Work';
    legacy.session.windows[0]!.panes[0]!.customName = 'Editor';
    overlay.capture(legacy);

    const canonical = snapshot([window('@1', ['%1', '%2'])]);
    if (!canonical.session) throw new Error('missing session');
    canonical.session.windows[0]!.customName = 'stale-window';
    canonical.session.windows[0]!.panes[0]!.customName = 'stale-pane';
    canonical.session.windows[0]!.panes[1]!.customName = 'removed-pane-name';
    const applied = overlay.apply(canonical);

    expect(applied.session?.windows[0]?.customName).toBe('Work');
    expect(applied.session?.windows[0]?.panes[0]?.customName).toBe('Editor');
    expect(applied.session?.windows[0]?.panes[1]?.customName).toBeUndefined();

    const patched = snapshot([window('@1', ['%1', '%2'])]);
    if (!patched.session) throw new Error('missing session');
    patched.session.windows[0]!.customName = 'New Work';
    patched.session.windows[0]!.panes[1]!.customName = 'Shell';
    const afterPatch = overlay.apply(patched);
    expect(afterPatch.session?.windows[0]?.customName).toBe('New Work');
    expect(afterPatch.session?.windows[0]?.panes[0]?.customName).toBeUndefined();
    expect(afterPatch.session?.windows[0]?.panes[1]?.customName).toBe('Shell');
  });

  test('drops device overlays on removal, empty snapshots, and disposal cleanup', () => {
    const overlay = new CanonicalMetadataOverlay();
    const legacy = snapshot([window('@2', ['%2']), window('@1', ['%1'])]);
    const canonical = snapshot([window('@1', ['%1']), window('@2', ['%2'])]);

    overlay.capture(legacy);
    overlay.remove('device-a');
    expect(overlay.apply(canonical).session?.windows.map((item) => item.id)).toEqual(['@1', '@2']);

    overlay.capture(legacy);
    overlay.capture({ deviceId: 'device-a', session: null });
    expect(overlay.apply(canonical).session?.windows.map((item) => item.id)).toEqual(['@1', '@2']);

    overlay.capture(legacy);
    overlay.clear();
    expect(overlay.apply(canonical).session?.windows.map((item) => item.id)).toEqual(['@1', '@2']);
  });
});
