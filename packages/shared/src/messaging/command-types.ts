export type CommandPermission = 'read' | 'execute' | 'approve';

export type MessagingPlatform = 'telegram' | 'weixin' | 'dingtalk';

export interface ArgSpec {
  name: string;
  required?: boolean;
  rest?: boolean;
}

export interface CommandSpec {
  name: string;
  aliases: string[];
  args: ArgSpec[];
  descriptionKey: string;
  requires: CommandPermission;
}

export interface CommandActor {
  platform: MessagingPlatform;
  accountId: string;
  conversationId: string;
  userId: string | null;
}

export interface CommandInvocation {
  command: string;
  args: string[];
  rawText: string;
  actor: CommandActor;
  nodeTarget?: string;
  tail?: string;
}

export interface CommandResultSection {
  title?: string;
  lines: string[];
  code?: boolean;
}

export interface CommandResultAction {
  label: string;
  command: string;
}

export interface CommandResultError {
  code: string;
  params?: Record<string, string | number | boolean | null>;
}

export interface CommandResult {
  text?: string;
  sections?: CommandResultSection[];
  actions?: CommandResultAction[];
  error?: CommandResultError;
}

export interface MeshNodeRef {
  id: string;
  name: string;
  online: boolean;
}

export interface NodeTargetLookup {
  localNodeId: string;
  localName: string;
  nodes: MeshNodeRef[];
}

export type NodeTargetErrorCode = 'unknown' | 'ambiguous' | 'offline';

export type NodeTargetResult =
  | { ok: true; node: MeshNodeRef; local: boolean }
  | { ok: false; error: NodeTargetErrorCode; input: string; candidates?: MeshNodeRef[] };
