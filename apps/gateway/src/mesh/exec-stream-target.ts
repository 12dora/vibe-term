import type { LinkStream } from '@vibeterm/shared/link';
import { attachExecChannelToLinkStream } from '../exec/channel/link-transport';
import {
  type ExecCredentialContext,
  type ExecCredentialResult,
  verifyExecCredential,
} from './exec-credential';
import { parseOpenPayload } from './peer-protocol';

type AttachExec = typeof attachExecChannelToLinkStream;

export function acceptExecStream(
  stream: LinkStream,
  ctx: ExecCredentialContext,
  attach: AttachExec = attachExecChannelToLinkStream
): void {
  const open = parseOpenPayload(stream.openPayload);
  const clientIp = typeof open?.clientIp === 'string' ? open.clientIp : undefined;
  const verified = safeVerify(open?.credential, clientIp ? { ...ctx, clientIp } : ctx);
  if (!verified.ok) {
    stream.reset(`auth:${verified.reason}`);
    return;
  }
  attach(stream, { uid: verified.uid, tokenId: verified.tokenId });
}

function safeVerify(credential: unknown, ctx: ExecCredentialContext): ExecCredentialResult {
  try {
    return verifyExecCredential(credential, ctx);
  } catch {
    return { ok: false, reason: 'error' };
  }
}
