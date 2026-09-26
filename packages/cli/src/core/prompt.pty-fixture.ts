import { writeFileSync } from 'node:fs';
import { promptHidden, promptLine } from './prompt';

const resultPath = process.env.PROMPT_RESULT ?? '';
if (!resultPath) throw new Error('PROMPT_RESULT is required');

const mode = process.argv[2] ?? 'both';

function record(payload: unknown): void {
  writeFileSync(resultPath, `${JSON.stringify(payload)}\n`);
}

if (mode === 'eof') {
  record({ value: await promptLine('Two-step verification code: ') });
} else if (mode === 'sigint') {
  try {
    await promptLine('Two-step verification code: ');
    record({ name: 'no-interrupt' });
  } catch (error) {
    record({ name: error instanceof Error ? error.name : 'unknown' });
  }
} else if (mode === 'long') {
  record({ value: await promptLine(process.env.PROMPT_TEXT ?? '') });
} else {
  const password = await promptHidden('Password: ');
  const code = await promptLine('Two-step verification code: ');
  record({ password, code });
}
