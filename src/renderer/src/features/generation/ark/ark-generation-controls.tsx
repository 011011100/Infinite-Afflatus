import { LoaderCircle, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { ArkGenerationPreview } from '../../../../../shared/generation/ark-types';
import { ArkJobHistory } from './ark-job-history';
import { arkDuplicateRisk } from './ark-job-presentation';
import { ArkRequestDetails } from './ark-request-details';
import type { useArkGeneration } from './use-ark-generation';

export function ArkGenerationControls({
  state,
  kind,
  disabled,
  pendingAdoptionJobId = null,
  canAdopt,
  onOpenSettings,
}: {
  state: ReturnType<typeof useArkGeneration>;
  kind: 'image' | 'video';
  disabled: boolean;
  pendingAdoptionJobId?: string | null;
  canAdopt: boolean;
  onOpenSettings?: (() => void) | undefined;
}) {
  const risky = state.uncertain || arkDuplicateRisk(state.jobs);
  return (
    <>
      <Button
        className="h-10 w-full"
        disabled={disabled || !!state.busy}
        onClick={() => void state.begin()}
      >
        <Sparkles />
        {kind === 'image' ? '生成图片' : '生成视频'}
      </Button>
      <Button
        className="mt-2 w-full text-xs"
        variant="ghost"
        onClick={state.history}
      >
        任务与候选{state.jobs.length > 0 ? `（${state.jobs.length}）` : ''}
      </Button>
      {state.view &&
        createPortal(
          <Modal
            title={state.view === 'review' ? '确认生成内容' : '生成任务与候选'}
            onClose={state.close}
            beforeClose={() =>
              Promise.resolve(!state.busy?.startsWith('adopt:'))
            }
            error={state.error}
          >
            {state.busy === 'preview' && (
              <p role="status" className="flex items-center gap-2 text-sm">
                <LoaderCircle className="size-4 animate-spin" />
                正在保存编辑并检查本次请求…
              </p>
            )}
            {state.view === 'review' && state.preview && (
              <ArkReview
                key={state.preview.token}
                preview={state.preview}
                duplicateRisk={risky}
                disabled={disabled || !!state.busy}
                submit={() => void state.submit()}
                cancel={state.close}
              />
            )}
            {state.view === 'review' &&
              !state.preview &&
              state.busy !== 'preview' && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    尚未发送生成请求。请处理上述问题后重新检查。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      disabled={disabled || !!state.busy}
                      onClick={() => void state.begin()}
                    >
                      重新检查生成内容
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => {
                        state.close();
                        onOpenSettings?.();
                      }}
                      disabled={!onOpenSettings}
                    >
                      打开设置 → 云端生成
                    </Button>
                    <Button variant="ghost" onClick={state.close}>
                      返回编辑
                    </Button>
                  </div>
                </div>
              )}
            {state.view === 'history' && (
              <div className="space-y-4">
                {pendingAdoptionJobId && (
                  <div className="space-y-2 rounded-lg border border-warning p-3">
                    <p role="alert" className="text-sm">
                      采纳结果尚未确认，已保留当前编辑锁。请确认同一个候选的结果；不会重复创建素材或视频卡片。
                    </p>
                    <Button
                      disabled={!!state.busy}
                      onClick={() => void state.adopt(pendingAdoptionJobId)}
                    >
                      重试采用确认
                    </Button>
                  </div>
                )}
                {state.busy === 'submit' && (
                  <p role="status" className="flex items-center gap-2 text-sm">
                    <LoaderCircle className="size-4 animate-spin" />
                    正在提交到火山方舟中国区，收起后可在这里查看。
                  </p>
                )}
                {state.historyError && (
                  <div>
                    <p role="alert" className="text-sm text-destructive">
                      任务记录暂时无法读取：{state.historyError}
                    </p>
                    <Button variant="ghost" onClick={() => void state.reload()}>
                      重新读取任务记录
                    </Button>
                  </div>
                )}
                <ArkJobHistory
                  jobs={state.jobs}
                  busy={state.busy}
                  disabled={disabled}
                  canAdopt={canAdopt}
                  pendingAdoptionJobId={pendingAdoptionJobId}
                  act={state.act}
                  adopt={state.adopt}
                />
                <p className="text-xs leading-relaxed text-muted-foreground">
                  候选采纳前不会进入主画布。下载和保存失败分别重试；新建生成任务会重新发送素材，并可能产生新费用。
                </p>
                <Button
                  variant="outline"
                  disabled={disabled || !!state.busy}
                  onClick={() => void state.begin()}
                >
                  {risky ? '核对后新建生成任务…' : '检查并新建生成任务…'}
                </Button>
              </div>
            )}
          </Modal>,
          document.body,
        )}
    </>
  );
}
function ArkReview({
  preview,
  duplicateRisk,
  disabled,
  submit,
  cancel,
}: {
  preview: ArkGenerationPreview;
  duplicateRisk: boolean;
  disabled: boolean;
  submit: () => void;
  cancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  return (
    <div className="space-y-5">
      <ArkRequestDetails request={preview} />
      <div className="space-y-2 rounded-lg bg-warning p-3 text-sm text-warning-foreground">
        <p>
          确认后，以上提示词与参考媒体将发送到火山方舟中国区，可能产生费用。
        </p>
        <p>{preview.transmissionNotice}</p>
        <p>{preview.costNotice}</p>
        {[...new Set(preview.warnings)].map((warning) => (
          <p key={warning}>{warning}</p>
        ))}
      </div>
      {duplicateRisk && (
        <label className="flex items-start gap-2 rounded-lg border border-destructive/40 p-3 text-sm">
          <input
            className="mt-1 shrink-0"
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
          />
          <span>
            之前的提交结果不确定。我已核对方舟任务，理解新建任务可能重复生成并再次计费。
          </span>
        </label>
      )}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={cancel}>
          取消
        </Button>
        <Button
          disabled={disabled || (duplicateRisk && !acknowledged)}
          onClick={submit}
        >
          确认发送到火山方舟中国区
        </Button>
      </div>
    </div>
  );
}
