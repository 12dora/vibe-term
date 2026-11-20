// 「登录命令」对话框：生成一次性登录命令（供 agent 在终端登录节点）。
// 两步：生成（目标 + 验证）→ 结果（命令、倒计时、各节点使用状态）。
// 签发模块经动态 import 按需加载，状态机见 `login-code-controller.ts`。
// 本文件整体由 `login-code-host.tsx` 懒加载，打开请求的宿主也在那里。

import { sortNodes, useMeshNodes } from '@/node/mesh-nodes';
import { Button } from '@vibeterm/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@vibeterm/ui/dialog';
import { Loader2 } from 'lucide-react';
import { type FormEvent, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  type LoginCodeController,
  type LoginCodeIssueError,
  type LoginCodeModuleLoader,
  type LoginCodeViewState,
  hasPendingNodes,
} from './login-code-controller';
import {
  type LoginCodeDraft,
  buildProof,
  draftResetForFailure,
  effectiveNodeIds,
  initialDraft,
} from './login-code-draft';
import { LoginCodeForm, type LoginCodeNodeOption } from './login-code-form';
import type { LoginCodeSelection } from './login-code-request';
import { LoginCodeResultView } from './login-code-result';
import { loginCodeErrorText } from './login-code-text';
import { useLoginCode, useNow } from './use-login-code';

const NS = 'nodes.loginCode';

export interface LoginCodeDialogProps {
  selection: LoginCodeSelection;
  onClose: () => void;
  /** 测试注入：替换签发模块的动态加载。 */
  loadModule?: LoginCodeModuleLoader;
}

function useDraft(selection: LoginCodeSelection) {
  const [draft, setDraft] = useState<LoginCodeDraft>(() => initialDraft(selection));
  const [focusSeq, setFocusSeq] = useState(0);
  const patch = (next: Partial<LoginCodeDraft>) => setDraft((prev) => ({ ...prev, ...next }));
  return { draft, patch, focusSeq, bumpFocus: () => setFocusSeq((n) => n + 1) };
}

/** 指定节点的可选项与计划：规则全部来自签发模块的 `planLoginCodeTargets`。 */
function usePlan(state: LoginCodeViewState, draft: LoginCodeDraft) {
  const { nodes } = useMeshNodes();
  const { scope, nodeIds } = draft;
  const { mod, context } = state;
  return useMemo(() => {
    if (!mod || !context) return null;
    const self = context.selfMeshId;
    const options: LoginCodeNodeOption[] = sortNodes(nodes, self).map((node) => ({
      meshId: node.id,
      name: node.name,
      reason: mod.planLoginCodeTargets([node], [node.id], self).skipped[0]?.reason ?? null,
    }));
    const selectedIds = effectiveNodeIds({ nodeIds }, options);
    const plan =
      scope === 'all'
        ? mod.planLoginCodeTargets(nodes, 'all', self)
        : mod.planLoginCodeTargets(nodes, selectedIds, self);
    return { options, selectedIds, plan };
  }, [mod, context, nodes, scope, nodeIds]);
}

function LoadErrorStep({
  controller,
  onClose,
}: { controller: LoginCodeController; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="text-sm text-destructive" role="alert" data-testid="login-code-load-error">
        {t(`${NS}.loadError`)}
      </p>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button onClick={() => void controller.load()} data-testid="login-code-retry">
          {t('common.retry')}
        </Button>
      </DialogFooter>
    </>
  );
}

function LoadingNotice() {
  const { t } = useTranslation();
  return (
    <div
      className="flex items-center gap-2 text-sm text-muted-foreground"
      data-testid="login-code-loading"
    >
      <Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
      {t('common.loading')}
    </div>
  );
}

function IssueError({ error }: { error: LoginCodeIssueError | null }) {
  const { t } = useTranslation();
  const text = error ? loginCodeErrorText(t, error.code, error.retryAfterMs) : '';
  return (
    <>
      <output className="sr-only" aria-live="polite">
        {text}
      </output>
      {error ? (
        <p className="text-sm text-destructive" data-testid="login-code-error">
          {text}
        </p>
      ) : null}
    </>
  );
}

function GenerateFooter({
  busy,
  ready,
  onClose,
}: { busy: boolean; ready: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  return (
    <DialogFooter>
      <Button type="button" variant="outline" disabled={busy} onClick={onClose}>
        {t('common.cancel')}
      </Button>
      <Button type="submit" disabled={!ready || busy} data-testid="login-code-generate">
        {busy && <Loader2 className="animate-spin motion-reduce:animate-none" />}
        {t(`${NS}.generate`)}
      </Button>
    </DialogFooter>
  );
}

function GenerateStep({
  controller,
  state,
  selection,
  onClose,
}: {
  controller: LoginCodeController;
  state: LoginCodeViewState;
  selection: LoginCodeSelection;
  onClose: () => void;
}) {
  const { draft, patch, focusSeq, bumpFocus } = useDraft(selection);
  const planned = usePlan(state, draft);
  const { context } = state;
  const busy = state.phase === 'generating';

  const proof = context ? buildProof(context, draft) : null;
  const targets = planned?.plan.targets ?? [];
  const ready = context !== null && planned !== null && proof !== null && targets.length > 0;

  const onDraft = (next: Partial<LoginCodeDraft>) => {
    controller.clearError();
    patch(next);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy || !planned || !proof) return;
    const res = await controller.generate({
      targets: planned.plan.targets,
      skipped: planned.plan.skipped,
      proof,
    });
    const reset = res && !res.ok ? draftResetForFailure(res.code) : null;
    if (reset) {
      patch(reset);
      bumpFocus();
    }
  };

  if (state.loadFailed) return <LoadErrorStep controller={controller} onClose={onClose} />;

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4">
      {context && planned ? (
        <LoginCodeForm
          context={context}
          draft={draft}
          onDraft={onDraft}
          options={planned.options}
          selectedIds={planned.selectedIds}
          targetCount={targets.length}
          skippedCount={planned.plan.skipped.length}
          busy={busy}
          focusSeq={focusSeq}
        />
      ) : (
        <LoadingNotice />
      )}
      <IssueError error={state.error} />
      <GenerateFooter busy={busy} ready={ready} onClose={onClose} />
    </form>
  );
}

function ResultStep({
  controller,
  state,
  onClose,
}: {
  controller: LoginCodeController;
  state: LoginCodeViewState;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const result = state.result;
  const expiresAt = result?.handle.expiresAt ?? 0;
  const now = useNow(result !== null);
  if (!result) return null;
  const pending = hasPendingNodes(result) && now < expiresAt;
  return (
    <>
      <LoginCodeResultView result={result} now={now} />
      <DialogFooter>
        {pending && (
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive sm:mr-auto"
            disabled={result.revoking}
            onClick={() => void controller.revoke()}
            data-testid="login-code-revoke"
          >
            {result.revoking && <Loader2 className="animate-spin motion-reduce:animate-none" />}
            {t(`${NS}.result.revoke`)}
          </Button>
        )}
        <Button type="button" onClick={onClose} data-testid="login-code-done">
          {t(`${NS}.result.done`)}
        </Button>
      </DialogFooter>
    </>
  );
}

export function LoginCodeDialog({ selection, onClose, loadModule }: LoginCodeDialogProps) {
  const { t } = useTranslation();
  const { controller, state } = useLoginCode(loadModule);
  const busy = state.phase === 'generating';
  const inResult = state.phase === 'result';

  const close = () => {
    // 先释放句柄再通知上层：命令一旦关掉就再也取不回来。
    controller.dispose();
    onClose();
  };

  return (
    <Dialog
      open
      // 生成中不可关；结果页命令只显示一次，点遮罩不算关闭，只能点「完成」或 Esc / ×。
      disablePointerDismissal={busy || inResult}
      onOpenChange={(next) => {
        if (!next && !busy) close();
      }}
    >
      <DialogContent
        showCloseButton={!busy}
        className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-md"
        data-testid="login-code-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t(`${NS}.title`)}</DialogTitle>
          {!inResult && <DialogDescription>{t(`${NS}.description`)}</DialogDescription>}
        </DialogHeader>
        {inResult ? (
          <ResultStep controller={controller} state={state} onClose={close} />
        ) : (
          <GenerateStep
            controller={controller}
            state={state}
            selection={selection}
            onClose={close}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
