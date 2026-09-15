import { json, readJsonObjectBody } from '../api/http';
import { type ApiRoute, route } from '../api/route';
import { requestWindowMemoryTickAll } from '../window-memory/runtime-host';
import {
  INVALID_WINDOW_MEMORY_SETTINGS,
  InvalidWindowMemorySettingsError,
  getWindowMemorySettingsStore,
} from '../window-memory/settings-store';

export { INVALID_WINDOW_MEMORY_SETTINGS };
export const WINDOW_MEMORY_SETTINGS_PATH = '/api/settings/window-memory';

function handleGet(): Response {
  return json(getWindowMemorySettingsStore().get());
}

async function handlePut(req: Request): Promise<Response> {
  const body = await readJsonObjectBody(req);
  if (!body) {
    return json(
      {
        code: INVALID_WINDOW_MEMORY_SETTINGS,
        error: {
          code: INVALID_WINDOW_MEMORY_SETTINGS,
          message: 'body must be an object',
        },
      },
      400
    );
  }
  try {
    const settings = getWindowMemorySettingsStore().set(body);
    requestWindowMemoryTickAll();
    return json(settings);
  } catch (err) {
    if (err instanceof InvalidWindowMemorySettingsError) {
      return json({ code: err.code, error: { code: err.code, message: err.message } }, 400);
    }
    throw err;
  }
}

export const windowMemorySettingsRoutes: ApiRoute[] = [
  route({ method: 'GET', path: WINDOW_MEMORY_SETTINGS_PATH, handler: () => handleGet() }),
  route({ method: 'PUT', path: WINDOW_MEMORY_SETTINGS_PATH, handler: (req) => handlePut(req) }),
];
