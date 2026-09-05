import { errorMessage } from '../lib/error-message';
import { SetupError } from './setup-service';

export { JSON_BODY_MAX_BYTES, readJsonBody } from '../../../shared/src/http/read-body';

export function jsonOk(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function jsonErr(code: string, message: string, status: number): Response {
  return jsonOk({ error: { code, message } }, status);
}

export function mapError(error: unknown, fallback = 'internal_error'): Response {
  if (error instanceof SetupError) {
    return jsonErr(error.code, error.message, error.httpStatus);
  }
  const message = errorMessage(error);
  return jsonErr(fallback, message, 500);
}
