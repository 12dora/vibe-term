// 步骤 4「生成加入码」：本机已加入 mesh 时就地生成，standalone 时只说明去哪儿生成。
//
// 创建逻辑与设置页共用 `useCreateEnrollment()`（唯一实现）；这里只负责把 mesh 模式、
// hub 通道与凭据对话框接上，并按四种状态渲染：非 mesh / hub 无公开地址 / 可生成 / 已生成。

import { decodeRootPublicKey, useCredentialPrompt, usePasskeys } from '@/auth/credential-prompt';
import { useHubNode, useSharedAuthMode } from '@/node/mesh-nodes';
import { PLACEHOLDER_KDF, type ResolvedMode } from '@/pages/settings/nodes/management/types';
import {
  type CreateEnrollmentState,
  useCreateEnrollment,
} from '@/pages/settings/nodes/management/use-create-enrollment';
import type { AuthKdfParamsJson, MeshNode } from '@tmex/api-client/auth/index';
import { defaultAuthApi } from '@tmex/api-client/auth/index';
import { Button } from '@tmex/ui/button';
import { Input } from '@tmex/ui/input';
import { Loader2, ShieldCheck } from 'lucide-react';
import type { ReactElement } from 'react';
import { useTranslation } from 'react-i18next';
import { CommandBlock } from './command-block';
import { GuideLink } from './guide-step';

/** hub 只靠 `/api/auth/mode` 的 `hubNodeId` 定位，不必把 mesh 列表也拉进侧滑面板。 */
const NO_MESH_NODES: MeshNode[] = [];

export interface JoinEnrollment {
  /** 本机是否已加入多节点互联；否则不能在此生成加入码。 */
  meshEnabled: boolean;
  /** hub 管理面是否可用（探测成功）。 */
  hubOnline: boolean;
  create: CreateEnrollmentState;
  /** 凭据对话框，必须由调用方挂进 DOM。 */
  dialog: ReactElement | null;
}

export function useJoinEnrollment(): JoinEnrollment {
  const api = defaultAuthApi;
  const { mode: rawMode, meshEnabled } = useSharedAuthMode(api);
  const hub = useHubNode(NO_MESH_NODES, {
    enabled: meshEnabled,
    hubNodeId: rawMode?.hubNodeId ?? null,
  });

  const hasCredentials = Boolean(rawMode?.uid && rawMode?.kdfParams);
  const mode: ResolvedMode | null =
    rawMode && hasCredentials
      ? {
          ...rawMode,
          uid: rawMode.uid as string,
          kdfParams: rawMode.kdfParams as AuthKdfParamsJson,
        }
      : null;

  const { passkeys } = usePasskeys(api, {
    enabled: meshEnabled && hasCredentials && rawMode?.passkeyAvailable === true,
  });
  const prompt = useCredentialPrompt({
    kdfParams: mode?.kdfParams ?? PLACEHOLDER_KDF,
    rootPublicKey: decodeRootPublicKey(rawMode?.rootPublicKey),
    passkeys,
    passkeyAvailable: rawMode?.passkeyAvailable ?? false,
  });

  const create = useCreateEnrollment({ api, mode, hubApi: hub.hubApi, prompt });
  return { meshEnabled, hubOnline: hub.online, create, dialog: prompt.dialog };
}

export function JoinTokenFields({ enrollment }: { enrollment: JoinEnrollment }) {
  const { t } = useTranslation();
  const { create } = enrollment;
  const settingsLink = (
    <GuideLink to="/settings?tab=nodes" testId="connect-join-token-link">
      {t('connectDevices.computer.join.token.link')}
    </GuideLink>
  );

  if (!enrollment.meshEnabled) {
    return (
      <>
        <p className="text-xs text-muted-foreground" data-testid="connect-join-token-unavailable">
          {t('connectDevices.computer.join.token.unavailable')}
        </p>
        {settingsLink}
      </>
    );
  }

  // hub 没给出对外地址就不能编 join 命令：用入口 origin 会把新机器指到没有 HubRuntime
  // 的机器上，redeem 直接 404（与设置页同一条判定）。
  if (!create.hubUrl) {
    return (
      <>
        <p className="text-xs text-destructive" data-testid="connect-join-no-url">
          {t('nodes.enrollment.missingHubUrl')}
        </p>
        {settingsLink}
      </>
    );
  }

  return (
    <>
      <Input
        placeholder={t('nodes.setup.fields.name')}
        value={create.name}
        data-testid="connect-join-name"
        onChange={(event) => create.setName(event.target.value)}
      />
      {create.error && (
        <p className="text-xs text-destructive" data-testid="connect-join-error">
          {create.error}
        </p>
      )}
      <div>
        <Button
          type="button"
          size="sm"
          disabled={create.busy || !enrollment.hubOnline}
          title={enrollment.hubOnline ? undefined : t('nodes.hubOffline')}
          onClick={() => void create.submit()}
          data-testid="connect-join-generate"
        >
          {create.busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
          {t('nodes.enrollment.create')}
        </Button>
      </div>
      {create.created && (
        <div className="flex flex-col gap-2" data-testid="connect-join-info">
          <CommandBlock
            value={create.created.joinToken}
            testId="join-token"
            label={t('nodes.enrollment.joinToken')}
          />
          <p className="text-xs text-muted-foreground">{t('nodes.enrollment.joinHint')}</p>
        </div>
      )}
    </>
  );
}
