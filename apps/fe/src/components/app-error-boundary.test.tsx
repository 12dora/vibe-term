// 应用级错误兜底。无 DOM 测试环境，用 react-dom/server 静态渲染，
// 而 react-dom/server 不支持错误边界：类边界的「接住」这一段直接驱动其状态迁移来验，
// 路由层那条则走 static handler（loader 抛 Response，错误在渲染前就进了 router context）。

import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type StaticHandlerContext,
  StaticRouterProvider,
  createStaticHandler,
  createStaticRouter,
} from 'react-router';
import {
  AppErrorBoundary,
  AppErrorFallback,
  RouteErrorElement,
  describeError,
  formatErrorDetails,
} from './app-error-boundary';

/** React Router 的路由错误是鸭子类型判定的（status / statusText / internal / data）。 */
const ROUTE_ERROR = { status: 500, statusText: 'Server Error', internal: false, data: 'nope' };

type BoundaryState = { error: unknown; attempt: number };

/** setState 在没有 reconciler 的情况下不会自己跑，这里手动落状态。 */
function drive(boundary: AppErrorBoundary, initial: BoundaryState): void {
  boundary.state = initial;
  (
    boundary as unknown as {
      setState: (updater: (prev: BoundaryState) => BoundaryState) => void;
    }
  ).setState = (updater) => {
    boundary.state = updater(boundary.state as BoundaryState);
  };
}

describe('AppErrorBoundary', () => {
  test('子树抛错时换成友好卡片，孩子不再渲染', () => {
    const error = new Error('boom');
    expect(AppErrorBoundary.getDerivedStateFromError(error)).toEqual({ error });

    const boundary = new AppErrorBoundary({ children: <span data-testid="child" /> });
    drive(boundary, { error, attempt: 0 });
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('data-testid="app-error"');
    expect(html).toContain('appError.title');
    expect(html).toContain('data-testid="app-error-retry"');
    expect(html).not.toContain('data-testid="child"');
  });

  test('重试清空错误、抬高重挂代次，孩子重新渲染', () => {
    const boundary = new AppErrorBoundary({ children: <span data-testid="child" /> });
    drive(boundary, { error: new Error('boom'), attempt: 0 });

    boundary.retry();

    expect(boundary.state).toEqual({ error: null, attempt: 1 });
    const html = renderToStaticMarkup(boundary.render());
    expect(html).toContain('data-testid="child"');
    expect(html).not.toContain('data-testid="app-error"');
  });

  test('panel 形态只给重试与关闭面板，不给重载 / 回首页', () => {
    const html = renderToStaticMarkup(
      <AppErrorFallback
        error={new Error('boom')}
        variant="panel"
        onRetry={() => undefined}
        onClose={() => undefined}
      />
    );
    expect(html).toContain('data-testid="panel-error"');
    expect(html).toContain('appError.panelDescription');
    expect(html).toContain('data-testid="app-error-retry"');
    expect(html).toContain('data-testid="app-error-close"');
    expect(html).not.toContain('data-testid="app-error-reload"');
    expect(html).not.toContain('data-testid="app-error-home"');
  });

  test('技术详情默认折起来', () => {
    const html = renderToStaticMarkup(
      <AppErrorFallback error={new Error('boom')} onRetry={() => undefined} />
    );
    expect(html).toContain('data-testid="app-error-details-toggle"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('data-testid="app-error-details"');
  });
});

describe('RouteErrorElement', () => {
  test('路由层错误落到自家卡片，而不是 React Router 的开发者页面', async () => {
    const routes = [
      {
        errorElement: <RouteErrorElement />,
        children: [
          {
            path: '/',
            loader: () => {
              throw new Response('nope', { status: 500, statusText: 'Server Error' });
            },
            element: <span data-testid="page" />,
          },
        ],
      },
    ];
    const handler = createStaticHandler(routes);
    const context = (await handler.query(new Request('http://localhost/'))) as StaticHandlerContext;
    const router = createStaticRouter(routes, context);

    const html = renderToStaticMarkup(<StaticRouterProvider router={router} context={context} />);
    expect(html).toContain('data-testid="app-error"');
    expect(html).toContain('appError.title');
    expect(html).not.toContain('Unexpected Application Error');
    expect(html).not.toContain('data-testid="page"');
  });
});

describe('describeError', () => {
  test('Error 给出信息与调用栈', () => {
    const details = describeError(new Error('boom'));
    expect(details.message).toBe('boom');
    expect(details.stack).toContain('boom');
  });

  test('路由错误响应拼成「状态码 状态文案 — 正文」', () => {
    expect(describeError(ROUTE_ERROR)).toEqual({
      message: '500 Server Error — nope',
      stack: null,
    });
  });

  test('字符串与任意对象都不至于变成 [object Object]', () => {
    expect(describeError('plain').message).toBe('plain');
    expect(describeError({ code: 7 }).message).toBe('{"code":7}');
  });

  test('复制出去的详情带上调用栈与当前地址', () => {
    const text = formatErrorDetails({ message: 'boom', stack: 'at foo' }, 'http://x/y');
    expect(text).toContain('boom');
    expect(text).toContain('at foo');
    expect(text).toContain('url: http://x/y');
  });
});
