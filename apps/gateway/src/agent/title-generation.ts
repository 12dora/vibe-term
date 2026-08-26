import { DEFAULT_AGENT_SESSION_TITLE } from '@tmex/shared';
import { buildTitleGenerationPrompt } from './prompts';

export function extractUserMessageText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof (part as { text?: unknown })?.text === 'string'
          ? (part as { text: string }).text
          : ''
      )
      .join(' ');
  }
  return '';
}

export function normalizeGeneratedTitle(raw: string): string {
  return raw
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .slice(0, 80);
}

export async function maybeGenerateSessionTitle(params: {
  currentTitle: string;
  messages: Array<{ role: string; content: unknown }>;
  generate: (prompt: string) => Promise<string>;
  apply: (title: string) => void;
  sessionId?: string;
}): Promise<void> {
  if (params.currentTitle !== DEFAULT_AGENT_SESSION_TITLE) {
    return;
  }

  const firstUser = params.messages.find((message) => message.role === 'user');
  if (!firstUser) {
    return;
  }

  const userText = extractUserMessageText((firstUser.content as { content?: unknown })?.content);
  if (!userText.trim()) {
    return;
  }

  try {
    const title = normalizeGeneratedTitle(
      await params.generate(buildTitleGenerationPrompt(userText))
    );
    if (!title) {
      return;
    }
    params.apply(title);
  } catch (error) {
    console.error(
      `[agent-run] title generation failed for ${params.sessionId ?? 'unknown'}:`,
      error
    );
  }
}
