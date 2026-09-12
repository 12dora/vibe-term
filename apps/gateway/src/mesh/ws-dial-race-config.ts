/**
 * WS 拨号竞速条数：运营商按五元组做 ECMP，同一对主机之间不同源端口的 RTT 可以差一倍，
 * 因此同时开 N 条连接、取最先 `open` 的那条。`VIBETERM_WS_DIAL_RACE` 在进程启动时读一次。
 */
export const WS_DIAL_RACE_MIN = 1;
export const WS_DIAL_RACE_MAX = 4;
export const WS_DIAL_RACE_DEFAULT = 2;

export function parseWsDialRace(raw: string | null | undefined): number {
  const text = raw?.trim();
  if (!text) return WS_DIAL_RACE_DEFAULT;
  const n = Number(text);
  if (!Number.isFinite(n)) return WS_DIAL_RACE_DEFAULT;
  return clampWsDialRace(Math.floor(n));
}

export function clampWsDialRace(n: number): number {
  if (!Number.isFinite(n)) return WS_DIAL_RACE_DEFAULT;
  const floored = Math.floor(n);
  if (floored < WS_DIAL_RACE_MIN) return WS_DIAL_RACE_MIN;
  if (floored > WS_DIAL_RACE_MAX) return WS_DIAL_RACE_MAX;
  return floored;
}

const configured = parseWsDialRace(process.env.VIBETERM_WS_DIAL_RACE);

export function wsDialRaceCount(): number {
  return configured;
}
