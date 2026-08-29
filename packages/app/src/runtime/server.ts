import './bootstrap-env';
import { resolve } from 'node:path';
import { CryptoDecryptError } from '../../../../apps/gateway/src/crypto/errors';
import { getDisplayVersion } from '../../../../apps/gateway/src/system/version';
import { t } from '../i18n';
import {
  assembleTmex,
  createProcessShutdown,
  installShutdownHandlers,
  meshShutdownNeeded,
} from './assemble';

function resolveStaticRoot(): string {
  if (process.env.TMEX_FE_DIST_DIR) {
    return resolve(process.env.TMEX_FE_DIST_DIR);
  }

  return resolve(import.meta.dir, '../../resources/fe-dist');
}

async function main(): Promise<void> {
  console.log(`[tmex] version ${getDisplayVersion()}`);
  const host = process.env.TMEX_BIND_HOST || '127.0.0.1';
  const port = Number(process.env.GATEWAY_PORT || '9883');
  const staticRoot = resolveStaticRoot();

  const assembled = await assembleTmex({ staticRoot });

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: assembled.fetch,
    websocket: assembled.websocket,
  });

  await assembled.start();
  await assembled.tls.startup();

  const stopAll = async () => {
    assembled.tls.stop();
    await assembled.httpsListener.stop();
    await assembled.stop();
    await server.stop(true);
  };

  const shutdownHooks = {
    exit: (code: number) => process.exit(assembled.isRestartRequested() ? 0 : code),
  };
  const runShutdown = meshShutdownNeeded(assembled.roles)
    ? installShutdownHandlers(stopAll, shutdownHooks)
    : createProcessShutdown(stopAll, shutdownHooks);

  assembled.setProcessShutdown(runShutdown);

  assembled.gateway.onRestartRequested(async () => {
    console.log(`[tmex] ${t('runtime.restartRequested')}`);
    await runShutdown();
  });

  console.log(`[tmex] ${t('runtime.started', { url: `http://${host}:${port}` })}`);
}

process.on('unhandledRejection', (reason) => {
  console.error('[tmex][unhandledRejection]', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[tmex][uncaughtException]', error);
});

try {
  await main();
} catch (error) {
  if (error instanceof CryptoDecryptError) {
    console.error('[tmex][fatal] 启动失败：检测到无法解密的敏感数据。');
    console.error(
      `[tmex][fatal] 上下文：scope=${error.context.scope} id=${error.context.entityId ?? '-'} field=${error.context.field ?? '-'}`
    );
    console.error(
      '[tmex][fatal] 请检查 app.env 中 TMEX_MASTER_KEY 是否与当前数据库匹配；如果数据库来自其他环境，请使用原密钥或手动重建相关密文配置。'
    );
    console.error('[tmex][fatal] 详细信息：', error.message);
  } else {
    console.error('[tmex][fatal] 启动失败：', error);
  }
  throw error;
}
