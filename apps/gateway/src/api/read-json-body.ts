import { t } from '../i18n';
import { json } from './http';

export type ReadJsonBodyResult<T> = { ok: true; value: T } | { ok: false; response: Response };

export async function readJsonBody<TIn, TOut>(
  req: Request,
  normalize: (body: TIn) => TOut
): Promise<ReadJsonBodyResult<TOut>> {
  try {
    const body = (await req.json()) as TIn;
    return { ok: true, value: normalize(body) };
  } catch (err) {
    return {
      ok: false,
      response: json(
        { error: err instanceof Error ? err.message : t('apiError.invalidRequest') },
        400
      ),
    };
  }
}
