import type { SshExternalTmuxConnection } from './ssh-external-connection';

let sshConnectionClass: typeof SshExternalTmuxConnection | null = null;

/** SSH 连接栈只在 SSH 设备首次建运行时加载；运行时构造是同步的，所以由调用方先 await。 */
export async function preloadSshConnection(): Promise<void> {
  sshConnectionClass ??= (await import('./ssh-external-connection')).SshExternalTmuxConnection;
}

export function loadedSshConnection(): typeof SshExternalTmuxConnection {
  if (!sshConnectionClass) throw new Error('ssh connection module not preloaded');
  return sshConnectionClass;
}
