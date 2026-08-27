import type { EventType, ThemeMode, WebhookEvent } from '@tmex/shared';
import { getTmuxWindowStyle, wsBorsh } from '@tmex/shared';
import { updateSiteSettings } from '../db';
import type { SettingsNamespace } from '../settings/broadcaster';
import type { GatewaySession } from './gateway-session';
import type { DeviceConnectionEntry } from './types';

export interface ThemeSettingsHost {
  readonly connectedClients: Set<GatewaySession>;
  readonly connections: Map<string, DeviceConnectionEntry>;
  sendEnvelope(session: GatewaySession, kind: number, payload: Uint8Array): void;
  sendError(
    session: GatewaySession,
    refSeq: number | null,
    code: number,
    message: string,
    retryable: boolean
  ): void;
}

export class ThemeSettingsBroadcaster {
  currentTheme: ThemeMode | null = null;
  readonly themeSignalLast = new Map<string, { theme: 'dark' | 'light'; at: number }>();
  readonly lastBroadcastTheme = new Map<string, 'dark' | 'light'>();
  private lastThemeTimestamp = 0n;
  private lastSettingsTimestamp = 0n;
  private pendingTmuxTheme: ThemeMode | null = null;
  private themeApplyInFlight = false;

  constructor(private readonly host: ThemeSettingsHost) {}

  clearDevice(deviceId: string): void {
    this.themeSignalLast.delete(deviceId);
    this.lastBroadcastTheme.delete(deviceId);
  }

  handleSiteThemeUpdate(
    session: GatewaySession,
    decoded: wsBorsh.b.infer<typeof wsBorsh.schema.SiteThemeUpdateC2SSchema>
  ): void {
    if (decoded.theme !== wsBorsh.SITE_THEME_DARK && decoded.theme !== wsBorsh.SITE_THEME_LIGHT) {
      this.host.sendError(
        session,
        null,
        wsBorsh.ERROR_PAYLOAD_DECODE_FAILED,
        `invalid theme value: ${decoded.theme}`,
        false
      );
      return;
    }
    const themeName: ThemeMode = decoded.theme === wsBorsh.SITE_THEME_LIGHT ? 'light' : 'dark';

    updateSiteSettings({ theme: themeName });
    this.scheduleTmuxThemeApply(themeName);
    this.broadcastSiteThemeUpdateS2C(themeName);
    this.broadcastSettingsUpdate('theme');
  }

  scheduleTmuxThemeApply(theme: ThemeMode): void {
    this.pendingTmuxTheme = theme;
    if (this.themeApplyInFlight) {
      return;
    }
    this.themeApplyInFlight = true;
    void (async () => {
      try {
        while (this.pendingTmuxTheme !== null) {
          const next = this.pendingTmuxTheme;
          this.pendingTmuxTheme = null;
          await this.handleSiteThemeChange(next);
          this.broadcastThemeChange(next);
        }
      } finally {
        this.themeApplyInFlight = false;
      }
    })();
  }

  broadcastSiteThemeUpdateS2C(theme: ThemeMode): void {
    const now = BigInt(Date.now());
    if (now <= this.lastThemeTimestamp) {
      this.lastThemeTimestamp += 1n;
    } else {
      this.lastThemeTimestamp = now;
    }
    const effectiveTimestamp = this.lastThemeTimestamp;

    const themeCode = theme === 'light' ? wsBorsh.SITE_THEME_LIGHT : wsBorsh.SITE_THEME_DARK;
    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.SiteThemeUpdateS2CSchema, {
      theme: themeCode,
      serverTimestamp: effectiveTimestamp,
    });
    for (const client of this.host.connectedClients) {
      this.host.sendEnvelope(client, wsBorsh.KIND_SITE_THEME_UPDATE, payloadBytes);
    }
  }

  broadcastSettingsUpdate(namespace: SettingsNamespace): void {
    const now = BigInt(Date.now());
    if (now <= this.lastSettingsTimestamp) {
      this.lastSettingsTimestamp += 1n;
    } else {
      this.lastSettingsTimestamp = now;
    }

    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.SettingsUpdateS2CSchema, {
      namespace,
      serverTimestamp: this.lastSettingsTimestamp,
    });
    for (const client of this.host.connectedClients) {
      this.host.sendEnvelope(client, wsBorsh.KIND_SETTINGS_UPDATE, payloadBytes);
    }
  }

  broadcastEventNotify(eventType: EventType, event: WebhookEvent): void {
    const eventTimeMs = Date.parse(event.timestamp);
    const payloadBytes = wsBorsh.encodePayload(wsBorsh.schema.EventNotifyS2CSchema, {
      eventType,
      eventJson: JSON.stringify(event),
      timestamp: BigInt(Number.isNaN(eventTimeMs) ? Date.now() : eventTimeMs),
    });
    for (const client of this.host.connectedClients) {
      this.host.sendEnvelope(client, wsBorsh.KIND_NOTIFY_EVENT, payloadBytes);
    }
  }

  async handleSiteThemeChange(theme: ThemeMode): Promise<void> {
    if (theme !== 'dark' && theme !== 'light') {
      return;
    }
    this.currentTheme = theme;
    const style = getTmuxWindowStyle(theme);
    const results = await Promise.allSettled(
      [...this.host.connections.values()].map((entry) => entry.runtime.setWindowStyle(style))
    );
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('[ws] setWindowStyle on theme change failed:', result.reason);
      }
    }
  }

  applyThemeToDevice(deviceId: string): void {
    if (this.currentTheme === null) {
      return;
    }
    const entry = this.host.connections.get(deviceId);
    if (!entry) {
      return;
    }
    const style = getTmuxWindowStyle(this.currentTheme);
    entry.runtime.setWindowStyle(style).catch((err) => {
      console.error(`[ws] setWindowStyle on device ${deviceId} failed:`, err);
    });
  }

  broadcastThemeChange(theme: 'dark' | 'light'): void {
    const now = Date.now();
    for (const [deviceId, entry] of this.host.connections) {
      const last = this.themeSignalLast.get(deviceId);
      if (last && last.theme === theme && now - last.at < 1000) {
        continue;
      }
      this.themeSignalLast.set(deviceId, { theme, at: now });
      this.lastBroadcastTheme.set(deviceId, theme);

      const panes = entry.lastSnapshot?.session?.windows?.flatMap((w) => w.panes) ?? [];
      for (const pane of panes) {
        try {
          entry.runtime.signalThemeChange(pane.id, theme);
        } catch (err) {
          console.error(`[ws] signalThemeChange failed for ${deviceId}/${pane.id}:`, err);
        }
      }
    }
  }
}
