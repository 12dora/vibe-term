import type { Client, ClientChannel, ConnectConfig } from 'ssh2';

export interface SshClientConnectHooks {
  reportError: (error: Error) => void;
  isManualDisconnect: () => boolean;
  onUnexpectedError: (error: Error) => void;
  onUnexpectedClose: () => void;
}

export async function establishSshClientConnection(
  client: Client,
  authConfig: ConnectConfig,
  hooks: SshClientConnectHooks
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const resolveOnce = () => {
      if (settled) {
        return;
      }
      settled = true;
      resolve();
    };
    const rejectOnce = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };

    client.on('ready', () => {
      resolveOnce();
    });
    client.on('error', (error) => {
      hooks.reportError(error);
      if (!settled) {
        rejectOnce(error);
        return;
      }
      if (!hooks.isManualDisconnect()) {
        hooks.onUnexpectedError(error);
      }
    });
    client.on('close', () => {
      if (!settled) {
        rejectOnce(new Error('SSH connection closed before ready'));
        return;
      }
      if (!hooks.isManualDisconnect()) {
        hooks.onUnexpectedClose();
      }
    });

    client.connect(authConfig);
  });
}

export function execSshShellChannel(sshClient: Client): Promise<ClientChannel> {
  return new Promise<ClientChannel>((resolve, reject) => {
    sshClient.exec('/bin/sh -s', { pty: false }, (error, channel) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(channel);
    });
  });
}
