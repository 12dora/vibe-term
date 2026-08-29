// admit 动作（自动 / 手动共用同一条路径）。
//
// 安全约束（设计 §2）：`admit-node` 只在 `certificate.enroll_pk` 命中本地 pending、
// `cert_sig` 验签通过、且 pending 未过期时才签；不匹配的证书告警「收到未知节点证书」并忽略。

import type { CredentialPromptHandle } from '@/auth/credential-prompt';
import { takeRememberedSigner } from '@/auth/credential-prompt';
import { type RecordSigner, headFromResponse } from '@/auth/key-log-actions';
import {
  type PendingEnrollment,
  type SignedRecord,
  admitPlan,
  buildAdmitNodeRecord,
  forgetUnconfirmedRecord,
  isPendingExpired,
  listUnconfirmedRecordIds,
  removePendingEnrollment,
  submitAdmitRecord,
  subscribeUnconfirmedRecords,
  unconfirmedRecord,
} from '@/node/enrollment';
import {
  type CertificateOutcome,
  collectRedeemedCertificates,
  offerCertificate,
} from '@/node/enrollment-watch';
import type { HubApi } from '@/node/hub-api';
import type { AuthApi } from '@tmex/api-client/auth/index';
import { requireRootEpoch } from '@tmex/api-client/auth/index';
import { encodeBase64url } from '@tmex/shared/auth';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { ResolvedMode } from './types';

/**
 * 证书一到就自动签 `admit-node`——只有根钥签名者可以这么干。
 *
 * passkey 每签一次都要一次认证器仪式，而仪式必须由用户手势触发（Safari 强制要求，
 * Chrome 也会因为缺少 user activation 拒掉）。后台自动发起注定失败，不如留在「待确认」：
 * 用户点按钮时复用窗口里的凭证还在，不必再选一次 passkey。
 */
export function canAutoSignAdmit(signer: RecordSigner | null): boolean {
  return signer?.kind === 'root';
}

export function useAdmitAction({
  api,
  mode,
  hubApi,
  prompt,
  onDone,
}: {
  api: AuthApi;
  mode: ResolvedMode | null;
  hubApi: HubApi | null;
  prompt: CredentialPromptHandle;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const [busyPendingId, setBusyPendingId] = useState<string | null>(null);
  /** 已 admit 掉的 pending（用于清掉页面上对应的 join 串）。 */
  const [admittedIds, setAdmittedIds] = useState<string[]>([]);
  /**
   * hub 未确认的 pending：保留待确认状态并给出重试入口。记录本身存在模块级 store 里，
   * 切走再回来仍然能原样重发（B2-6：未确认时服务端什么都没落库，同一条记录仍然有效）。
   */
  const hubUnconfirmedIds = useSyncExternalStore(
    subscribeUnconfirmedRecords,
    listUnconfirmedRecordIds,
    listUnconfirmedRecordIds
  );

  /** 把一条**已签好**的 admit 记录送出去，并按 B2-6 的码处理结果。 */
  const submitAdmit = useCallback(
    async (pending: PendingEnrollment, record: SignedRecord) => {
      const id = pending.hubEnrollmentId;
      // hub=sync：entry 先把记录送 hub 并等 ack，确认之前本地什么都不写。
      const disposition = await submitAdmitRecord(api, id, record);
      if (disposition.kind === 'unconfirmed') {
        // hub 没确认就删 pending 会把 enroll 授权丢掉，而新 node 永远成不了 mesh 成员。
        toast.warning(t('nodes.enrollment.hubNotConfirmed'));
        return;
      }
      if (disposition.kind === 'stale') {
        // fork / seq_gap：这份字节永远不会被接受，让用户重新签一条。
        toast.error(t('nodes.enrollment.staleRecord'));
        return;
      }
      if (disposition.kind === 'error') {
        toast.error(t(`auth.errors.${disposition.code}`, { defaultValue: disposition.code }));
        return;
      }
      removePendingEnrollment(id);
      setAdmittedIds((ids) => [...ids, id]);
      toast.success(t('nodes.enrollment.admitted'));
      onDone();
    },
    [api, onDone, t]
  );

  const signAdmit = useCallback(
    async (
      pending: PendingEnrollment,
      certificateBytes: Uint8Array,
      certSig: Uint8Array,
      signer: RecordSigner
    ) => {
      if (!mode) return;
      const head = headFromResponse(await api.keyLogHead());
      // 取 head 是异步的：这中间 pending 可能已经过期，过期后签出来的 admit 也不该被接受。
      if (isPendingExpired(pending, Date.now())) {
        toast.error(t('nodes.enrollment.expired'));
        forgetUnconfirmedRecord(pending.hubEnrollmentId);
        removePendingEnrollment(pending.hubEnrollmentId);
        setAdmittedIds((ids) => [...ids, pending.hubEnrollmentId]);
        return;
      }
      const record = await buildAdmitNodeRecord({
        head,
        rootEpoch: requireRootEpoch(mode),
        uid: mode.uid,
        pending,
        certificateBytes,
        certSig,
        signer,
      });
      await submitAdmit(pending, {
        bytes: encodeBase64url(record.bytes),
        sig: encodeBase64url(record.sig),
      });
    },
    [api, mode, submitAdmit, t]
  );

  /** 轮询 / 推送检测出的结果。已过期或签名坏的直接告警；能自动签就自动签。 */
  const handleOutcome = useCallback(
    async (outcome: CertificateOutcome) => {
      if (outcome.kind === 'unknown') {
        toast.error(t('nodes.enrollment.unknownCertificate'));
        return;
      }
      if (outcome.kind === 'invalid') {
        toast.error(
          outcome.reason === 'expired'
            ? t('nodes.enrollment.expired')
            : t('nodes.enrollment.badCertSig')
        );
        return;
      }
      const id = outcome.pending.hubEnrollmentId;
      const signer = takeRememberedSigner(Date.now());
      // 复用窗口已过、或窗口里是 passkey：都留在「待确认」，等用户点按钮。
      const plan = admitPlan(id, canAutoSignAdmit(signer));
      if (plan === 'wait') return;
      setBusyPendingId(id);
      try {
        const stored = unconfirmedRecord(id);
        if (plan === 'resend' && stored) await submitAdmit(outcome.pending, stored);
        else if (signer) {
          await signAdmit(outcome.pending, outcome.certificateBytes, outcome.certSig, signer);
        }
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPendingId(null);
      }
    },
    [signAdmit, submitAdmit, t]
  );

  /**
   * 「待确认 / 重试」按钮。
   *
   * 该 pending 手上还留着一条 hub 未确认的记录时，**只重发这份字节**：不要凭据、不取新 head、
   * 不重新签名。B2-6 保证未确认时服务端没落库，本地 head 没动，原记录仍然接得上；
   * 而重签会按（可能已推进的）本地 head 产生新 seq，一旦 hub 缺中间那条就永久拒绝。
   */
  const confirmManually = useCallback(
    async (pending: PendingEnrollment) => {
      if (!mode) return;
      const stored = unconfirmedRecord(pending.hubEnrollmentId);
      if (stored) {
        setBusyPendingId(pending.hubEnrollmentId);
        try {
          await submitAdmit(pending, stored);
        } catch (err) {
          toast.error(err instanceof Error ? err.message : String(err));
        } finally {
          setBusyPendingId(null);
        }
        return;
      }
      let signer: RecordSigner | null;
      try {
        // request() 会把签名者放进 5 分钟复用窗口，后续自动 admit 直接用它。
        signer = await prompt.request({ purpose: 'admit', reuse: true });
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
        return;
      }
      if (!signer) return;
      setBusyPendingId(pending.hubEnrollmentId);
      try {
        const candidates = hubApi ? await collectRedeemedCertificates(hubApi, [pending]) : [];
        for (const candidate of candidates) {
          const outcome = offerCertificate([pending], candidate, Date.now());
          if (outcome.kind === 'admit') {
            await signAdmit(pending, outcome.certificateBytes, outcome.certSig, signer);
            return;
          }
          if (outcome.kind === 'invalid') {
            toast.error(
              outcome.reason === 'expired'
                ? t('nodes.enrollment.expired')
                : t('nodes.enrollment.badCertSig')
            );
            return;
          }
        }
        toast.error(t('nodes.enrollment.noCertificateYet'));
      } catch (err) {
        toast.error(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyPendingId(null);
      }
    },
    [hubApi, mode, prompt, signAdmit, submitAdmit, t]
  );

  return { handleOutcome, confirmManually, busyPendingId, hubUnconfirmedIds, admittedIds };
}
