export type CanDialDirectInput = {
  paused: boolean;
  allowsUpgrade: boolean;
  breakerAllows: boolean;
  permanentHold: boolean;
  upgradeCooling: boolean;
  peerInitiated: boolean;
};

/** 后台升级在入队前问这一次。挡住就直接返回，不记尝试、不涨退避。 */
export function evaluateCanDialDirect(input: CanDialDirectInput): boolean {
  if (input.paused) return false;
  if (!input.allowsUpgrade) return false;
  if (input.peerInitiated) return true;
  if (input.permanentHold) return false;
  if (!input.breakerAllows) return false;
  if (input.upgradeCooling) return false;
  return true;
}
