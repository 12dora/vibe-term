export function planCopySelection(text: string): 'empty' | 'write' {
  return text ? 'write' : 'empty';
}

export function nextAutoCopyText(text: string, lastCopied: string | null): string | null {
  if (!text || text === lastCopied) {
    return null;
  }
  return text;
}
