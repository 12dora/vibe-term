import { t } from '../i18n';
import type { LocalAuthContext } from '../lib/local-auth';
import { alsoConfiguredLine } from '../lib/relay-store';
import { formatPortPlanForEnv } from '../runtime/local-port-plan';
import { relayJoinRoleName } from '../runtime/setup-shared';
import type { RestartOutcome } from './restart';

/** 服务没有被重启时，成员关系要等用户手动重启才生效，结论里必须说清楚。 */
export function joinDoneKey(restart: RestartOutcome): string {
  return restart === 'manual' ? 'relay.join.doneRestart' : 'relay.join.done';
}

/**
 * 加入后的摘要：中继、同时配置的中继、入站端口放在前面；最后一行永远是结论——
 * 已加入打印「加入成功」（服务没重启时带上重启指引），等待批准打印要做什么。
 */
export function logRelayJoinSummary(
  log: (message: string) => void,
  input: {
    url: string;
    tenantId: string;
    relayUrls: readonly string[];
    env: LocalAuthContext['env'] | undefined;
    pending: boolean;
    restart: RestartOutcome;
  }
): void {
  log(t('relay.join.relay', { url: input.url, tenantId: input.tenantId }));
  const alsoConfigured = alsoConfiguredLine(input.url, input.relayUrls);
  if (alsoConfigured) log(alsoConfigured);
  const list = formatPortPlanForEnv({
    ...input.env,
    VIBETERM_ROLES: relayJoinRoleName(
      input.env?.VIBETERM_ROLES ?? process.env.VIBETERM_ROLES ?? undefined
    ),
  });
  if (list) log(t('relay.join.portsHint', { list }));
  log(t(input.pending ? 'relay.join.pending' : joinDoneKey(input.restart)));
}
