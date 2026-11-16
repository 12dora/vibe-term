import { t } from '../i18n';

export class AgentSessionNotFoundError extends Error {
  constructor() {
    super(t('apiError.agentSessionNotFound'));
    this.name = 'AgentSessionNotFoundError';
  }
}

export class AgentSessionBusyError extends Error {
  constructor() {
    super(t('apiError.agentSessionBusy'));
    this.name = 'AgentSessionBusyError';
  }
}

export class AgentAwaitingConfirmationError extends Error {
  constructor() {
    super(t('apiError.agentSessionAwaitingConfirmation'));
    this.name = 'AgentAwaitingConfirmationError';
  }
}

export class AgentConfirmationNotFoundError extends Error {
  constructor() {
    super(t('apiError.agentConfirmationNotFound'));
    this.name = 'AgentConfirmationNotFoundError';
  }
}

export class AgentConfirmationAlreadyDecidedError extends Error {
  constructor() {
    super(t('apiError.agentConfirmationAlreadyDecided'));
    this.name = 'AgentConfirmationAlreadyDecidedError';
  }
}

export class AgentSessionOrphanedError extends Error {
  constructor() {
    super(t('apiError.agentSessionOrphaned'));
    this.name = 'AgentSessionOrphanedError';
  }
}

export class AgentQueuedMessageNotFoundError extends Error {
  constructor() {
    super(t('apiError.agentQueuedMessageNotFound'));
    this.name = 'AgentQueuedMessageNotFoundError';
  }
}
