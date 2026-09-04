import type { WebhookEvent } from '@tmex/shared';

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

export function eventNodeId(event: WebhookEvent): string | null {
  const raw = event.payload?.nodeId;
  if (typeof raw !== 'string') return null;
  const nodeId = raw.trim();
  return nodeId.length > 0 ? nodeId : null;
}

function nodePathPrefix(event: WebhookEvent): string {
  const nodeId = eventNodeId(event);
  return nodeId ? `/n/${encodeURIComponent(nodeId)}` : '';
}

export function buildPaneUrl(event: WebhookEvent): string | null {
  const base = trimTrailingSlash(event.site.url);
  const prefix = nodePathPrefix(event);
  const deviceId = event.device.id;
  if (!deviceId || deviceId === '-') {
    return null;
  }
  const encodedDevice = encodeURIComponent(deviceId);
  if (event.tmux?.windowId && event.tmux?.paneId) {
    const windowId = encodeURIComponent(event.tmux.windowId);
    const paneId = encodeURIComponent(event.tmux.paneId);
    return `${base}${prefix}/devices/${encodedDevice}/windows/${windowId}/panes/${paneId}`;
  }
  if (prefix) {
    return `${base}${prefix}/devices/${encodedDevice}`;
  }
  return null;
}

export function normalizeHttpUrl(input: string | null): string | null {
  if (!input) {
    return null;
  }

  try {
    const parsed = new URL(input);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.toString();
    }
    return null;
  } catch {
    return null;
  }
}
