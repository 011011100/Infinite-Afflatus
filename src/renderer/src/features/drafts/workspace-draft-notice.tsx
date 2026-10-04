import { Button } from '@/components/ui/button';
import type { GenerationWorkspace } from '../../../../shared/generation/workspace';
import {
  type WorkspaceDraftRecord,
  workspaceDraftState,
} from '../../../../shared/workspace-draft';
import type { useWorkspaceDrafts } from './use-workspace-drafts';

export function WorkspaceDraftNotice({
  recovery,
  baseline,
  dirty,
  blocked,
  recovering,
  restore,
}: {
  recovery: ReturnType<typeof useWorkspaceDrafts>;
  baseline: GenerationWorkspace | null;
  dirty: boolean;
  blocked: boolean;
  recovering: boolean;
  restore: (record: WorkspaceDraftRecord) => Promise<boolean>;
}) {
  const warning = recovery.error ?? recovery.protection.error;
  const showCurrent = !!recovery.queue.snapshot() && (!!warning || blocked);
  if (
    !recovery.drafts.length &&
    !recovery.issues.length &&
    !warning &&
    !showCurrent &&
    !recovery.notice
  )
    return null;
  return (
    <section
      aria-label="镜头恢复草稿"
      className="max-h-52 shrink-0 overflow-auto border-b bg-warning px-4 py-3 text-xs text-warning-foreground"
    >
      <p className="font-medium">镜头恢复草稿</p>
      <p className="mt-1 leading-5">
        仅保护镜头文字、参数、分组和素材引用；不含未提交的名称输入、主画布裁剪或原始媒体。恢复文件用于救援，不能作为完整项目包导入。
      </p>
      {warning && (
        <p role="alert" className="mt-2">
          {warning}
        </p>
      )}
      {recovery.issues.map((issue) => (
        <p role="alert" key={issue.file} className="mt-2 break-all">
          {issue.file}：{issue.message}。文件已保留，未影响原项目。
        </p>
      ))}
      {recovery.drafts.map((draft) => {
        const state = baseline
          ? workspaceDraftState(draft, baseline)
          : 'conflict';
        return (
          <div
            key={draft.sessionId}
            className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2"
          >
            <span className="min-w-0 flex-1">
              {new Date(draft.updatedAt).toLocaleString()} ·{' '}
              {state === 'conflict'
                ? '项目内容与草稿对应的版本不同，恢复副本已保留。'
                : state === 'submitted'
                  ? '此草稿内容已在项目中，确认后保留当前版本。'
                  : '发现未保存的镜头草稿，可恢复。'}
            </span>
            <Button
              size="sm"
              variant="outline"
              disabled={
                blocked ||
                recovering ||
                recovery.busy ||
                dirty ||
                state === 'conflict'
              }
              onClick={() => void restore(draft)}
            >
              {state === 'submitted' ? '确认已保存' : '恢复镜头草稿'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={recovery.busy || recovering}
              onClick={() => void recovery.exportDraft(draft)}
            >
              导出恢复文件
            </Button>
          </div>
        );
      })}
      <div className="mt-2 flex flex-wrap gap-2">
        {showCurrent && (
          <Button
            size="sm"
            variant="outline"
            disabled={recovery.busy || recovering}
            onClick={() => void recovery.exportDraft()}
          >
            导出当前镜头草稿
          </Button>
        )}
        {(warning || recovery.issues.length > 0) && (
          <Button
            size="sm"
            variant="ghost"
            disabled={recovery.busy || recovering}
            onClick={() => {
              void recovery.queue.flush();
              void recovery.refresh();
            }}
          >
            重试检查恢复副本
          </Button>
        )}
      </div>
      {recovery.notice && (
        <p role="status" className="mt-2 break-all">
          {recovery.notice}
        </p>
      )}
    </section>
  );
}
