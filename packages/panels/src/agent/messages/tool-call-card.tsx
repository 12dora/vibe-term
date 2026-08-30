import type { UiToolCall } from '@tmex/stores';
import { cn } from '@tmex/ui';
import { Badge } from '@tmex/ui/badge';
import { Button } from '@tmex/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@tmex/ui/collapsible';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@tmex/ui/dialog';
import {
  CheckIcon,
  ChevronRightIcon,
  CircleAlertIcon,
  GlobeIcon,
  KeyboardIcon,
  Loader2Icon,
  MonitorIcon,
  SearchIcon,
  WrenchIcon,
  XIcon,
} from 'lucide-react';
import { createContext, memo, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { actionBrief, asText, isRecord } from './tool-brief';

export interface ToolCardConfirmation {
  id: string;
  toolCallId: string;
}

interface ToolCallCardProps {
  call: UiToolCall;
  confirmationId?: string;
  onDecide?: (confirmationId: string, approved: boolean) => void;
  className?: string;
}

function callErrorText(call: UiToolCall): string | null {
  if (isRecord(call.output) && typeof call.output.error === 'string') {
    return call.output.error;
  }
  if (call.isError) {
    return asText(call.output);
  }
  return null;
}

const DetailsExpandedContext = createContext(false);

const PREVIEW_MAX_CHARS = 64 * 1024;
const PREVIEW_MAX_LINES = 2000;

/** 挂进 DOM 的预览长度：64 KiB 与 2000 行取先到者；完整串只留在内存里供复制 */
export function previewEnd(text: string): number {
  const cap = Math.min(text.length, PREVIEW_MAX_CHARS);
  let index = 0;
  for (let line = 0; line < PREVIEW_MAX_LINES; line++) {
    const next = text.indexOf('\n', index);
    if (next < 0 || next >= cap) return cap;
    index = next + 1;
  }
  return index;
}

function CollapsedText({ label, text }: { label: string; text: string }) {
  const { t } = useTranslation();
  const defaultOpen = useContext(DetailsExpandedContext);
  const end = previewEnd(text);
  return (
    <Collapsible defaultOpen={defaultOpen}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground group flex items-center gap-1 text-xs">
        <ChevronRightIcon className="size-3 transition-transform group-data-[panel-open]:rotate-90" />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <pre className="bg-muted mt-1 max-h-64 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {end < text.length ? text.slice(0, end) : text}
        </pre>
        {end < text.length && (
          <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span data-testid="agent-tool-preview-note">
              {t('agent.tool.previewNote', { shown: end, total: text.length })}
            </span>
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void navigator.clipboard?.writeText(text)}
            >
              {t('agent.tool.copyFull')}
            </Button>
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface WebSearchResultItem {
  title: string;
  url: string;
  snippet: string;
}

function parseWebSearchResults(output: unknown): WebSearchResultItem[] | null {
  if (typeof output !== 'string') return null;
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed
      .filter(isRecord)
      .map((item) => ({
        title: typeof item.title === 'string' ? item.title : '',
        url: typeof item.url === 'string' ? item.url : '',
        snippet: typeof item.snippet === 'string' ? item.snippet : '',
      }))
      .filter((item) => item.url);
  } catch {
    // 输出可能被字节上限截断导致 JSON 不完整
    return null;
  }
}

function SendInputBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const input = isRecord(call.input) ? call.input : {};
  const text = typeof input.text === 'string' ? input.text : '';
  const keys = Array.isArray(input.keys)
    ? input.keys.filter((k): k is string => typeof k === 'string')
    : [];
  const combos = Array.isArray(input.combos) ? input.combos.filter(isRecord) : [];
  const output = isRecord(call.output) ? call.output : {};
  const screenTail = typeof output.screenTail === 'string' ? output.screenTail : '';

  const showKeyBadges = keys.length > 0 || combos.length > 0;

  return (
    <div className="flex flex-col gap-1.5">
      {text && (
        <pre className="bg-muted max-h-40 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-all">
          {text}
        </pre>
      )}
      {showKeyBadges && (
        <div className="flex flex-wrap items-center gap-1">
          {keys.map((key, index) => (
            <Badge key={`k-${index}-${key}`} variant="outline" className="font-mono">
              {key}
            </Badge>
          ))}
          {combos.map((combo, index) => {
            const mods = Array.isArray(combo.modifiers)
              ? combo.modifiers.filter((m): m is string => typeof m === 'string')
              : [];
            const key = typeof combo.key === 'string' ? combo.key : '';
            if (!key && mods.length === 0) return null;
            const label = [...mods.map((m) => `${m.charAt(0).toUpperCase()}${m.slice(1)}`), key]
              .filter(Boolean)
              .join('+');
            return (
              <Badge key={`c-${index}-${label}`} variant="outline" className="font-mono">
                {label}
              </Badge>
            );
          })}
        </div>
      )}
      {screenTail && <CollapsedText label={t('agent.tool.result')} text={screenTail} />}
    </div>
  );
}

function ReadScreenBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const output = isRecord(call.output) ? call.output : {};
  const screen = typeof output.screen === 'string' ? output.screen : '';
  if (!screen) return null;
  return <CollapsedText label={t('agent.tool.screen')} text={screen} />;
}

function WebSearchBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const input = isRecord(call.input) ? call.input : {};
  const query = typeof input.query === 'string' ? input.query : '';
  const results =
    call.resolved && !call.isError && !call.denied ? parseWebSearchResults(call.output) : null;

  return (
    <div className="flex flex-col gap-1.5">
      {query && <p className="text-muted-foreground text-xs break-words">“{query}”</p>}
      {results && results.length > 0 && (
        <ul className="flex flex-col gap-1">
          {results.map((item) => (
            <li key={item.url} className="min-w-0 text-xs">
              <a
                href={item.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary block truncate underline underline-offset-2"
                title={item.title || item.url}
              >
                {item.title || item.url}
              </a>
              {item.snippet && (
                <p className="text-muted-foreground line-clamp-2 break-words">{item.snippet}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {call.resolved &&
        !call.isError &&
        !call.denied &&
        !results &&
        typeof call.output === 'string' && (
          <CollapsedText label={t('agent.tool.result')} text={call.output} />
        )}
    </div>
  );
}

function FetchUrlBody({ call }: { call: UiToolCall }) {
  const { t } = useTranslation();
  const input = isRecord(call.input) ? call.input : {};
  const url = typeof input.url === 'string' ? input.url : '';
  const body = typeof call.output === 'string' ? call.output : '';

  return (
    <div className="flex flex-col gap-1.5">
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary block truncate text-xs underline underline-offset-2"
          title={url}
        >
          {url}
        </a>
      )}
      {call.resolved && !call.isError && !call.denied && body && (
        <CollapsedText label={t('agent.tool.result')} text={body} />
      )}
    </div>
  );
}

const BASE64_IMAGE_RE = /^[A-Za-z0-9+/]{256,}={0,2}$/;
const IMAGE_URL_RE = /^https?:\/\/\S+\.(png|jpe?g|webp|gif)(\?\S*)?$/i;

/** 超过该长度的值不再探测：整串拷贝与正则的代价远超收益 */
const IMAGE_VALUE_MAX_CHARS = 512 * 1024;

function asImageSrc(value: unknown, allowBareBase64: boolean): string | null {
  if (typeof value !== 'string' || value.length === 0) return null;
  if (value.length > IMAGE_VALUE_MAX_CHARS) return null;
  if (value.startsWith('data:image/')) return value;
  if (IMAGE_URL_RE.test(value)) return value;
  if (!allowBareBase64) return null;
  // 裸 base64（如 OpenAI image_generation 的 { result }）默认按 png 处理
  const compact = value.replace(/\s/g, '');
  return BASE64_IMAGE_RE.test(compact) ? `data:image/png;base64,${compact}` : null;
}

/** 通用：从 tool output 探测可内联渲染的图片（image_generation 的 result / image / images 等字段） */
export function extractToolImages(call: UiToolCall): string[] {
  if (!call.resolved || call.isError || call.denied) return [];
  // 裸 base64 猜测只对出图工具开放，普通工具的长输出不做全串扫描
  const allowBareBase64 = call.toolName.toLowerCase().includes('image');
  const images: string[] = [];
  const visit = (value: unknown, depth: number): void => {
    if (images.length >= 8 || depth > 3) return;
    const src = asImageSrc(value, allowBareBase64);
    if (src) {
      images.push(src);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (isRecord(value)) {
      for (const key of ['result', 'image', 'images', 'url', 'b64_json', 'data']) {
        if (key in value) visit(value[key], depth + 1);
      }
    }
  };
  visit(call.output, 0);
  return [...new Set(images)];
}

function ToolImages({ images }: { images: string[] }) {
  const { t } = useTranslation();
  if (images.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-2">
      {images.map((src, index) => (
        <a
          // biome-ignore lint/suspicious/noArrayIndexKey: 顺序稳定的图片列表
          key={index}
          href={src}
          target="_blank"
          rel="noopener noreferrer"
          className="block"
        >
          <img
            src={src}
            alt={t('agent.tool.imageAlt')}
            className="max-h-64 max-w-full rounded-md border border-border object-contain"
            loading="lazy"
          />
        </a>
      ))}
    </div>
  );
}

function GenericBody({ call, hideOutput }: { call: UiToolCall; hideOutput?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      {call.input !== undefined && (
        <CollapsedText label={t('agent.tool.input')} text={asText(call.input)} />
      )}
      {!hideOutput &&
        call.resolved &&
        !call.isError &&
        !call.denied &&
        call.output !== undefined && (
          <CollapsedText label={t('agent.tool.result')} text={asText(call.output)} />
        )}
    </div>
  );
}

interface ToolView {
  icon: ReactNode;
  /** 缺省时用 GenericBody 展示原始 input/output */
  Body?: (props: { call: UiToolCall }) => ReactNode;
}

/** 已知工具的图标与详情渲染；键同时决定工具名是否走 i18n 展示名 */
const TOOL_VIEWS = new Map<string, ToolView>([
  ['send_input', { icon: <KeyboardIcon className="size-3.5" />, Body: SendInputBody }],
  ['read_screen', { icon: <MonitorIcon className="size-3.5" />, Body: ReadScreenBody }],
  ['web_search', { icon: <SearchIcon className="size-3.5" />, Body: WebSearchBody }],
  ['fetch_url', { icon: <GlobeIcon className="size-3.5" />, Body: FetchUrlBody }],
  ['run_command', { icon: <WrenchIcon className="size-3.5" /> }],
  ['get_pane_info', { icon: <WrenchIcon className="size-3.5" /> }],
]);

const FALLBACK_ICON = <WrenchIcon className="size-3.5" />;

interface ToolCallStatus {
  pendingApproval: boolean;
  denied: boolean;
  errorText: string | null;
  deniedReason: string;
  running: boolean;
}

function toolCallStatus(call: UiToolCall, confirmationId: string | undefined): ToolCallStatus {
  const pendingApproval = Boolean(confirmationId) && !call.resolved;
  const denied = call.resolved && call.denied;
  return {
    pendingApproval,
    denied,
    errorText: call.resolved && !denied ? callErrorText(call) : null,
    deniedReason: denied && typeof call.output === 'string' ? call.output : '',
    running: !call.resolved && !pendingApproval,
  };
}

/** 四态互斥：运行中 / 出错 / 被拒 / 成功；待确认（未 resolved 且非运行）不显示图标 */
function ToolStatusIcon({ call, status }: { call: UiToolCall; status: ToolCallStatus }) {
  if (status.running) {
    return <Loader2Icon className="text-muted-foreground size-3 shrink-0 animate-spin" />;
  }
  if (!call.resolved) return null;
  if (status.errorText !== null) {
    return <CircleAlertIcon className="text-destructive size-3 shrink-0" />;
  }
  if (status.denied) {
    return <XIcon className="text-destructive size-3 shrink-0" />;
  }
  return <CheckIcon className="size-3 shrink-0 text-emerald-500" />;
}

function ToolApproval({
  call,
  confirmationId,
  onDecide,
}: {
  call: UiToolCall;
  confirmationId: string;
  onDecide?: (confirmationId: string, approved: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-testid={`agent-tool-approval-${call.toolCallId}`}
      className="flex items-center gap-2 pt-1"
    >
      <span className="text-muted-foreground min-w-0 flex-1 text-xs">
        {t('agent.confirm.title')}
      </span>
      <Button
        data-testid="agent-confirm-approve"
        size="xs"
        variant="secondary"
        onClick={() => onDecide?.(confirmationId, true)}
      >
        <CheckIcon />
        {t('agent.confirm.approve')}
      </Button>
      <Button
        data-testid="agent-confirm-deny"
        size="xs"
        variant="destructive"
        onClick={() => onDecide?.(confirmationId, false)}
      >
        <XIcon />
        {t('agent.confirm.deny')}
      </Button>
    </div>
  );
}

/** 仅在弹窗打开时挂载：图片探测按 call 记忆，不随每次重渲染重扫 output */
export function ToolDetailsBody({ call, view }: { call: UiToolCall; view: ToolView | undefined }) {
  const images = useMemo(() => extractToolImages(call), [call]);
  const Body = view?.Body;
  return (
    <div className="text-muted-foreground flex flex-col gap-3 overflow-auto text-xs">
      <DetailsExpandedContext.Provider value={true}>
        {Body ? <Body call={call} /> : <GenericBody call={call} hideOutput={images.length > 0} />}
        <ToolImages images={images} />
      </DetailsExpandedContext.Provider>
    </div>
  );
}

function ToolDetailsDialog({
  call,
  view,
  icon,
  label,
  open,
  onOpenChange,
}: {
  call: UiToolCall;
  view: ToolView | undefined;
  icon: ReactNode;
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-2xl flex-col gap-3 overflow-hidden sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-sm">
            {icon}
            <span>{label}</span>
          </DialogTitle>
        </DialogHeader>
        <ToolDetailsBody call={call} view={view} />
      </DialogContent>
    </Dialog>
  );
}

export const ToolCallCard = memo(function ToolCallCard({
  call,
  confirmationId,
  onDecide,
  className,
}: ToolCallCardProps) {
  const { t } = useTranslation();
  const [dialogOpen, setDialogOpen] = useState(false);
  const status = toolCallStatus(call, confirmationId);
  const view = TOOL_VIEWS.get(call.toolName);
  const icon = view?.icon ?? FALLBACK_ICON;
  const toolLabel = view ? t(`agent.tool.${call.toolName}`) : call.toolName;

  return (
    <div
      data-tool-name={call.toolName}
      data-tool-denied={status.denied || undefined}
      className={cn(
        'border-border bg-card flex max-w-full min-w-0 flex-col gap-1.5 self-start rounded-lg border p-2',
        status.errorText !== null && 'border-destructive/50',
        status.denied && 'opacity-80',
        className
      )}
    >
      <button
        type="button"
        onClick={() => setDialogOpen(true)}
        data-testid={`agent-tool-card-${call.toolCallId}`}
        className="border-border bg-card/50 hover:bg-accent/50 flex max-w-full min-w-0 items-center gap-1.5 rounded-md border px-1.5 py-1 text-xs transition-colors"
      >
        {icon}
        <span className="min-w-0 shrink-0 font-medium truncate">{toolLabel}</span>
        <span className="text-muted-foreground min-w-0 flex-1 truncate">{actionBrief(call)}</span>
        <ToolStatusIcon call={call} status={status} />
      </button>

      {status.errorText !== null && (
        <p className="text-destructive text-xs break-words whitespace-pre-wrap">
          {status.errorText}
        </p>
      )}

      {status.deniedReason && (
        <p className="text-muted-foreground text-xs break-words whitespace-pre-wrap">
          {status.deniedReason}
        </p>
      )}

      {status.pendingApproval && confirmationId && (
        <ToolApproval call={call} confirmationId={confirmationId} onDecide={onDecide} />
      )}

      <ToolDetailsDialog
        call={call}
        view={view}
        icon={icon}
        label={toolLabel}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
      />
    </div>
  );
});
