import { getDeviceById } from '../db';
import { execNdjsonResponse } from '../exec/ndjson';
import { parseExecRequest } from '../exec/parse';
import { runExec } from '../exec/service';
import { json, readJsonObjectBody } from './http';
import { type ApiRoute, route } from './route';

function fail(code: string, message: string): Response {
  return json({ code, message }, 400);
}

async function handleExec(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) return fail('invalid_body', 'request body must be a JSON object');
  const parsed = parseExecRequest(body);
  if (!parsed.ok) return fail(parsed.code, parsed.message);
  const device = getDeviceById(parsed.value.deviceId);
  if (!device) return fail('device_not_found', 'device not found');
  if (device.type === 'ssh' && device.authMode === 'password') {
    return fail('exec_unsupported_device', 'password-auth SSH devices are not supported');
  }
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });
  return execNdjsonResponse(
    (emit, isOpen) =>
      runExec(device, parsed.value, { emit: (event) => emit(event), isOpen }, ac.signal),
    () => ac.abort()
  );
}

export const execRoutes: ApiRoute[] = [
  route({ method: 'POST', path: '/api/exec', handler: (req) => handleExec(req) }),
];
