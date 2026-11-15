import type { DeviceConnectionErrorType } from '@vibeterm/shared';

const RAW_MESSAGE_MAX = 120;

export function classifySshError(error: Error): {
  type: DeviceConnectionErrorType;
  messageKey: string;
  messageParams?: Record<string, unknown>;
} {
  const msg = error.message.toLowerCase();

  if (msg.includes('ssh_config_ref_not_supported')) {
    return {
      type: 'ssh_config_ref_not_supported',
      messageKey: 'sshError.configRefNotSupported',
    };
  }
  if (isAgentSockError(msg)) {
    return {
      type: 'agent_unavailable',
      messageKey: 'sshError.agentUnavailable',
    };
  }
  if (isAgentNoIdentity(msg)) {
    return {
      type: 'agent_no_identity',
      messageKey: 'sshError.agentNoIdentities',
    };
  }
  if (msg.includes('permission denied')) {
    return {
      type: 'auth_failed',
      messageKey: 'sshError.authFailed',
    };
  }
  if (msg.includes('all configured authentication methods failed')) {
    return {
      type: 'auth_failed',
      messageKey: 'sshError.authFailedGeneric',
    };
  }
  if (isNetworkUnreachable(msg)) {
    return {
      type: 'network_unreachable',
      messageKey: 'sshError.networkUnreachable',
    };
  }
  if (isConnectionRefused(msg)) {
    return {
      type: 'connection_refused',
      messageKey: 'sshError.connectionRefused',
    };
  }
  if (isTmuxUnavailable(msg)) {
    return {
      type: 'tmux_unavailable',
      messageKey: 'sshError.tmuxUnavailable',
    };
  }
  if (isTmuxBusyMessage(msg)) {
    return {
      type: 'tmux_busy',
      messageKey: 'sshError.tmux_busy',
    };
  }
  if (isNetworkTimeout(msg)) {
    return {
      type: 'timeout',
      messageKey: 'sshError.connectionTimeout',
    };
  }
  if (isHostNotFound(msg)) {
    return {
      type: 'host_not_found',
      messageKey: 'sshError.hostNotFound',
    };
  }
  if (isHandshakeFailed(msg)) {
    return {
      type: 'handshake_failed',
      messageKey: 'sshError.handshakeFailed',
    };
  }
  if (isConnectionClosed(msg)) {
    return {
      type: 'connection_closed',
      messageKey: 'sshError.connectionClosed',
    };
  }

  return {
    type: 'unknown',
    messageKey: 'sshError.unknown',
    messageParams: { message: sanitizeTmuxErrorMessage(error.message) },
  };
}

export function isTmuxBusyError(error: Error): boolean {
  return isTmuxBusyRawMessage(error.message);
}

export function isTmuxBusyRawMessage(raw: string): boolean {
  return isTmuxBusyMessage(raw.toLowerCase());
}

export function sanitizeTmuxErrorMessage(raw: string): string {
  const stripped = stripUserKeystrokes(raw);
  if (!isTmuxCommandText(stripped)) return stripped;
  if (stripped.length <= RAW_MESSAGE_MAX) return stripped;
  return stripped.slice(0, RAW_MESSAGE_MAX);
}

function isTmuxBusyMessage(msg: string): boolean {
  if (msg.includes('tmux control command timed out')) return true;
  if (msg.includes('tmux control command queue is closed')) return true;
  if (msg.includes('heartbeat timeout') && msg.includes('tmux')) return true;
  if (msg.includes('tmux control channel slow')) return true;
  if (msg.includes('tmux control channel stalled')) return true;
  if (msg.includes('tmux control channel busy')) return true;
  return false;
}

function isAgentSockError(msg: string): boolean {
  return msg.includes('ssh_auth_sock') || msg.includes('auth_sock');
}

function isAgentNoIdentity(msg: string): boolean {
  return msg.includes('agent') && (msg.includes('no identities') || msg.includes('failure'));
}

function isNetworkUnreachable(msg: string): boolean {
  return msg.includes('enetunreach') || msg.includes('ehostunreach');
}

function isConnectionRefused(msg: string): boolean {
  return (
    msg.includes('connect refused') ||
    msg.includes('connection refused') ||
    msg.includes('econnrefused')
  );
}

function isNetworkTimeout(msg: string): boolean {
  return msg.includes('timeout') || msg.includes('etimedout');
}

function isHostNotFound(msg: string): boolean {
  return msg.includes('host not found') || msg.includes('getaddrinfo') || msg.includes('enotfound');
}

function isHandshakeFailed(msg: string): boolean {
  return msg.includes('handshake failed') || msg.includes('unable to verify');
}

function isTmuxUnavailable(msg: string): boolean {
  return (
    msg.includes('remote tmux unavailable') ||
    msg.includes('tmux_not_found') ||
    msg.includes('tmux: command not found') ||
    msg.includes('tmux control mode not ready') ||
    msg.includes('tmux exited') ||
    msg.includes('tmux_exec_failed')
  );
}

function isConnectionClosed(msg: string): boolean {
  return (
    msg.includes('ssh_connection_closed') ||
    msg.includes('connection closed') ||
    msg.includes('ssh command channel not ready') ||
    msg.includes('ssh connection not ready') ||
    msg.includes('channel closed')
  );
}

function stripUserKeystrokes(raw: string): string {
  const sendKeys = raw.search(/\bsend-keys\b/i);
  if (sendKeys >= 0) return `${raw.slice(0, sendKeys)}send-keys`;
  const hexFlag = raw.search(/(?:^|\s)-H(?:\s|$)/);
  if (hexFlag < 0) return raw;
  const prefix = raw.slice(0, hexFlag).trimEnd();
  return prefix ? `${prefix} send-keys` : 'send-keys';
}

function isTmuxCommandText(text: string): boolean {
  const msg = text.toLowerCase();
  if (msg.includes('tmux')) return true;
  if (msg.includes('send-keys')) return true;
  if (msg.includes('control command')) return true;
  return msg.includes('control channel');
}
