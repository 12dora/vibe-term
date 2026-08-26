import { handleAgentApiRequest } from './agent';
import { handleLlmApiRequest } from './llm';
import { type ApiRoute, route } from './route';
import { handleWatchApiRequest } from './watch';

export const agentRoutes: ApiRoute[] = [
  route({
    method: '*',
    path: '/api/llm/*',
    handler: (req, _params, ctx) => handleLlmApiRequest(req, ctx.path),
  }),
  route({
    method: '*',
    path: '/api/agent/*',
    handler: (req, _params, ctx) => handleAgentApiRequest(req, ctx.path),
  }),
  route({
    method: '*',
    path: '/api/watch/*',
    handler: (req, _params, ctx) => handleWatchApiRequest(req, ctx.path),
  }),
];
