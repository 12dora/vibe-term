import type { tool as AiTool } from 'ai';
import { createMemoizedLoader } from '../lazy-load';

const aiLoader = createMemoizedLoader(() => import('ai'));
const openaiLoader = createMemoizedLoader(() => import('@ai-sdk/openai'));
const openaiCompatLoader = createMemoizedLoader(() => import('@ai-sdk/openai-compatible'));

let toolFn: typeof AiTool | undefined;

export async function loadAiSdk() {
  const ai = await aiLoader.load();
  toolFn = ai.tool;
  return ai;
}

export function peekAiSdk() {
  return aiLoader.peek();
}

export function getAiTool(): typeof AiTool {
  if (!toolFn) {
    throw new Error('AI SDK is not loaded');
  }
  return toolFn;
}

export function loadOpenAIProvider() {
  return openaiLoader.load();
}

export function loadOpenAICompatibleProvider() {
  return openaiCompatLoader.load();
}

export function resetAiSdkLoadersForTests() {
  aiLoader.reset();
  openaiLoader.reset();
  openaiCompatLoader.reset();
  toolFn = undefined;
}
