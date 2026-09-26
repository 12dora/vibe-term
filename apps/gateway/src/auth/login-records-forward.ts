import { peekJsonCode } from '../mesh/forwarder-auth-policy';
import { recordForwardedAuthRejected } from './login-records-hooks';
import { warnLoginRecord } from './login-records-service';

export async function recordEntryLogin429(
  entryNodeId: string,
  req: Request,
  targetNodeId: string,
  gated: { response: Response | null; uidHint: string; ip: string }
): Promise<void> {
  const response = gated.response;
  if (!response || response.status !== 429) return;
  try {
    const code = (await peekJsonCode(response.clone())) || 'RATE_LIMITED';
    if (code === 'SHARE_LOGIN_LOCKED') return;
    recordForwardedAuthRejected({
      req,
      entryNodeId,
      targetNodeId,
      uid: gated.uidHint,
      ip: gated.ip,
      code,
    });
  } catch (err) {
    warnLoginRecord(err);
  }
}
