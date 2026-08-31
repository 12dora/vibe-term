import { memo, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type { AgentWriteMode } from '@tmex/shared';
import { Button } from '@tmex/ui/button';
import { Switch } from '@tmex/ui/switch';
import { Textarea } from '@tmex/ui/textarea';
import { SendIcon, SparklesIcon, SquareIcon, ZapIcon } from 'lucide-react';

import { ModelPicker } from './model-picker';

interface ComposerControls {
  writeMode: AgentWriteMode;
  allowControlChars: boolean;
  modelProviderId: string | null;
  modelId: string | null;
  hasActiveSession: boolean;
  isOrphan: boolean;
  onModelChange: (providerId: string | null, modelId: string) => void;
  onWriteModeChange: (writeMode: AgentWriteMode) => void;
  onAllowControlCharsChange: (allow: boolean) => void;
}

/** 写入模式与控制字符开关：全是原始值 props，流式刷新不会让它失效 */
const WriteModeControls = memo(function WriteModeControls({
  writeMode,
  allowControlChars,
  hasActiveSession,
  isOrphan,
  onWriteModeChange,
  onAllowControlCharsChange,
}: Omit<ComposerControls, 'modelProviderId' | 'modelId' | 'onModelChange'>) {
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
      <div className="flex min-w-0 items-center gap-1.5">
        <span className="text-muted-foreground truncate text-xs">
          {writeMode === 'auto' ? t('agent.writeMode.auto') : t('agent.writeMode.confirm')}
        </span>
        <Switch
          data-testid="agent-write-mode-switch"
          checked={writeMode === 'auto'}
          disabled={hasActiveSession && isOrphan}
          onCheckedChange={(checked) => {
            onWriteModeChange(checked ? 'auto' : 'confirm');
          }}
        />
      </div>
      {hasActiveSession && (
        <div className="flex min-w-0 items-center gap-1.5">
          <span
            className="text-muted-foreground truncate text-xs"
            title={t('agent.controlChars.hint')}
          >
            {t('agent.controlChars.label')}
          </span>
          <Switch
            data-testid="agent-control-chars-switch"
            checked={allowControlChars}
            disabled={isOrphan}
            title={t('agent.controlChars.hint')}
            onCheckedChange={onAllowControlCharsChange}
          />
        </div>
      )}
    </div>
  );
});

const ChatInput = memo(function ChatInput({
  onSend,
  onSteer,
  onStop,
  running,
  disabled,
  draftPrompt,
  ...controls
}: ComposerControls & {
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onStop: () => void;
  running: boolean;
  disabled: boolean;
  /** 本 node 草稿上的预填 prompt（rsync 自动安装流程） */
  draftPrompt: string | null;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState('');

  // 消费草稿预填 prompt：出现新预填值时填入输入框一次，等待用户手动发送。
  const appliedPromptRef = useRef<string | null>(null);
  useEffect(() => {
    if (draftPrompt && draftPrompt !== appliedPromptRef.current) {
      appliedPromptRef.current = draftPrompt;
      setText(draftPrompt);
    }
  }, [draftPrompt]);

  const submit = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setText('');
  };

  const steer = (): void => {
    const trimmed = text.trim();
    if (!trimmed || disabled) return;
    onSteer(trimmed);
    setText('');
  };

  return (
    <div
      data-testid="agent-chat-input"
      className="bg-chat-surface flex shrink-0 flex-col gap-2 mx-3 mb-2.5 rounded-xl mt-1.5 focus-within:ring-1 focus-within:ring-ring/30"
    >
      <Textarea
        data-testid="agent-chat-input-textarea"
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            submit();
          }
        }}
        placeholder={t('agent.panel.inputPlaceholder')}
        disabled={disabled}
        className="max-h-40 min-h-[4.5rem] w-full resize-none border-transparent bg-transparent p-3 text-[13px] shadow-none focus-visible:border-transparent focus-visible:ring-0 disabled:bg-transparent dark:bg-transparent dark:disabled:bg-transparent"
        rows={3}
      />
      {/* 控件与操作按钮是同级 flex item：窄侧栏放不下时按 basis 换行下沉，
          而不是让不可收缩的控件溢出去盖住发送/停止按钮 */}
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5 px-2.5 pb-2.5">
        <WriteModeControls {...controls} />
        <div className="min-w-0 flex-1 basis-32">
          <ModelPicker
            providerId={controls.modelProviderId}
            modelId={controls.modelId}
            onChange={controls.onModelChange}
            disabled={running}
          />
        </div>
        {running ? (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {controls.hasActiveSession && (
              <Button
                data-testid="agent-chat-steer"
                size="icon"
                variant="outline"
                disabled={disabled || text.trim().length === 0}
                onClick={steer}
                aria-label={t('agent.queue.steer')}
                title={t('agent.queue.steerHint')}
              >
                <ZapIcon />
              </Button>
            )}
            <Button
              data-testid="agent-chat-send"
              size="icon"
              variant="secondary"
              disabled={disabled || text.trim().length === 0}
              onClick={submit}
              aria-label={t('agent.panel.send')}
            >
              <SendIcon />
            </Button>
            <Button
              data-testid="agent-chat-stop"
              size="icon"
              variant="destructive"
              onClick={onStop}
              aria-label={t('agent.panel.stop')}
            >
              <SquareIcon />
            </Button>
          </div>
        ) : (
          <Button
            data-testid="agent-chat-send"
            size="icon"
            className="ml-auto shrink-0"
            disabled={disabled || text.trim().length === 0}
            onClick={submit}
            aria-label={t('agent.panel.send')}
          >
            <SendIcon />
          </Button>
        )}
      </div>
    </div>
  );
});

/** 输入区：空草稿态的欢迎块 + 输入框及其模型 / 写入模式控件 */
export const AgentComposer = memo(function AgentComposer({
  draftEmpty,
  ...input
}: ComposerControls & {
  draftEmpty: boolean;
  draftPrompt: string | null;
  disabled: boolean;
  running: boolean;
  onSend: (text: string) => void;
  onSteer: (text: string) => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className={draftEmpty ? 'flex min-h-0 flex-1 flex-col justify-center' : 'contents'}>
      {draftEmpty && (
        <div className="flex flex-col items-center gap-2 px-6 pb-6 text-center">
          <SparklesIcon className="text-muted-foreground size-9" />
          <h3 className="text-sm font-medium">{t('agent.welcome.title')}</h3>
          <p className="text-muted-foreground text-xs">{t('agent.welcome.subtitle')}</p>
        </div>
      )}
      <ChatInput {...input} />
    </div>
  );
});
