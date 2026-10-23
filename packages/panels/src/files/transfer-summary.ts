// 批量上传结束后的结果文案：全部成功 / 部分失败 / 用户取消三种。

import type { TFunction } from 'i18next';
import type { BatchFinish, ItemOutcome } from './transfer-batch';
import {
  type TransferFailure,
  describeBatchFailures,
  describeTransferError,
} from './transfer-errors';

function collectFailures(
  names: readonly string[],
  outcomes: readonly ItemOutcome[]
): TransferFailure[] {
  const failures: TransferFailure[] = [];
  outcomes.forEach((outcome, index) => {
    if (outcome.status !== 'failed') return;
    failures.push({ name: names[index] ?? '', error: outcome.error });
  });
  return failures;
}

function singleFailure(failure: TransferFailure, t: TFunction): BatchFinish {
  return {
    kind: 'failure',
    message: t('files.upload.fail', { name: failure.name }),
    description: describeTransferError(failure.error, t) || undefined,
  };
}

export function summarizeUploadBatch(
  names: readonly string[],
  outcomes: readonly ItemOutcome[],
  cancelled: boolean,
  t: TFunction
): BatchFinish {
  if (cancelled) return { kind: 'cancel' };
  const failures = collectFailures(names, outcomes);
  const [first] = failures;
  if (first === undefined) {
    return {
      kind: 'success',
      message:
        names.length === 1
          ? t('files.upload.success', { name: names[0] })
          : t('files.transfer.uploadedBatch', { count: names.length }),
    };
  }
  if (names.length === 1) return singleFailure(first, t);
  return {
    kind: 'failure',
    message: t('files.transfer.uploadBatchFailed', { count: failures.length }),
    description: describeBatchFailures(failures, t),
  };
}
