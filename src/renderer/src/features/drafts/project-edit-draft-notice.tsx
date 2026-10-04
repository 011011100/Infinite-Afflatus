import { Button } from '@/components/ui/button';
import type { ClipTrim } from '../../../../shared/canvas/trim';
import type { ProjectSnapshot } from '../../../../shared/models';
import {
  type ProjectEditDraftRecord,
  projectEditDraftState,
} from '../../../../shared/project-edit-draft';
import type { useProjectEditDrafts } from './use-project-edit-drafts';

const rangeLabel = (range: ClipTrim | undefined) =>
  range
    ? `${Number(range.start.toFixed(3))}–${Number(range.end.toFixed(3))} 秒`
    : '原片';

function summary(record: ProjectEditDraftRecord, current: ProjectSnapshot) {
  if (record.kind === 'name')
    return `项目名称：${record.target.trim() ? record.target : '（空名称输入）'}`;
  const card = current.canvas.cards.find(
    (item) => item.id === record.baseline.id,
  );
  const before = card ?? record.baseline;
  const changed = record.assets.flatMap((asset, index) => {
    const original = before.trims?.[asset.id];
    const target = record.target.trims?.[asset.id];
    if (original?.start === target?.start && original?.end === target?.end)
      return [];
    return [
      `第 ${index + 1} 段 ${asset.name}：${rangeLabel(original)} → ${rangeLabel(target)}`,
    ];
  });
  return changed.length
    ? `${changed.slice(0, 3).join('；')}${changed.length > 3 ? `；共 ${changed.length} 段` : ''}`
    : `${record.assets.length} 段视频的裁剪修改`;
}

export function ProjectEditDraftNotice({
  recovery,
  snapshot,
  blocked,
  activeNameSession,
  nameEditing,
  openName,
}: {
  recovery: ReturnType<typeof useProjectEditDrafts>;
  snapshot: ProjectSnapshot;
  blocked: boolean;
  activeNameSession: string | null;
  nameEditing: boolean;
  openName: (record: ProjectEditDraftRecord) => void;
}) {
  const drafts = recovery.drafts.filter(
    (draft) => draft.sessionId !== activeNameSession,
  );
  if (
    !drafts.length &&
    !recovery.issues.length &&
    !recovery.error &&
    !recovery.notice
  )
    return null;
  return (
    <section
      className="max-h-[40vh] shrink-0 overflow-y-auto border-b bg-warning px-6 py-3 text-sm text-warning-foreground"
      aria-label="项目编辑恢复草稿"
    >
      {(drafts.length > 0 || recovery.issues.length > 0) && (
        <p>
          发现项目名称或裁剪恢复副本。只有明确恢复才会修改项目，原视频保持不变。
        </p>
      )}
      {recovery.error && (
        <p role="alert" className="break-words">
          {recovery.error}
        </p>
      )}
      {recovery.issues.length > 0 && (
        <details className="mt-2 text-xs">
          <summary>
            有 {recovery.issues.length} 份副本无法读取，原文件已保留
          </summary>
          {recovery.issues.map((issue) => (
            <p key={issue.file} className="mt-1 break-all">
              {issue.file}：{issue.message}
            </p>
          ))}
        </details>
      )}
      {drafts.map((record) => {
        const state =
          record.project.folder === snapshot.project.folder
            ? projectEditDraftState(record, snapshot)
            : 'conflict';
        const unavailable =
          blocked || recovery.busy || nameEditing || !recovery.canRecover;
        return (
          <div
            key={record.sessionId}
            className="mt-3 flex flex-wrap items-center gap-2 border-t pt-2"
          >
            <div className="min-w-0 flex-1 basis-64">
              <p className="break-words">{summary(record, snapshot)}</p>
              {record.kind === 'name' && state === 'conflict' && (
                <p className="mt-1 break-words text-xs">
                  当前名称：{snapshot.project.name}
                </p>
              )}
              <p className="mt-1 text-xs">
                {new Date(record.updatedAt).toLocaleString()} ·{' '}
                {state === 'conflict'
                  ? '当前内容与原版本不同，恢复副本已保留。'
                  : state === 'submitted'
                    ? '此修改已在项目中，可确认清理恢复副本。'
                    : record.kind === 'name'
                      ? '继续修改会填回名称输入，仍需点击保存。'
                      : '恢复前会再次核对视频组合、素材与原范围。'}
              </p>
            </div>
            <Button
              size="sm"
              variant="outline"
              disabled={unavailable || state === 'conflict'}
              onClick={() => {
                if (state === 'submitted') void recovery.acknowledge(record);
                else if (record.kind === 'name') openName(record);
                else void recovery.recover(record);
              }}
            >
              {state === 'submitted'
                ? '确认已保存'
                : record.kind === 'name'
                  ? '继续修改名称'
                  : '恢复并保存裁剪'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={recovery.busy}
              onClick={() =>
                void recovery.exportDraft({
                  sessionId: record.sessionId,
                  seq: record.seq,
                })
              }
            >
              导出恢复文件
            </Button>
          </div>
        );
      })}
      {(recovery.error || recovery.issues.length > 0) && (
        <Button
          size="sm"
          variant="ghost"
          className="mt-2"
          disabled={recovery.busy}
          onClick={() => void recovery.refresh()}
        >
          重新检查恢复副本
        </Button>
      )}
      {recovery.notice && (
        <div className="mt-2 flex items-center gap-2">
          <p role="status" className="min-w-0 flex-1 break-all">
            {recovery.notice}
          </p>
          <Button size="sm" variant="ghost" onClick={recovery.dismissNotice}>
            关闭提示
          </Button>
        </div>
      )}
    </section>
  );
}
