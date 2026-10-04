import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { usePendingSave } from '../lifecycle/use-pending-save';
import { projectErrorMessage } from '../projects/library-session';
import type { TrimDraftController } from '../workspace/editor/trim-draft-controller';

export function TrimProtectionNotice({
  projectId,
  controller,
  error,
}: {
  projectId: string;
  controller: TrimDraftController;
  error: string | null;
}) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const pending = useRef<Promise<boolean> | null>(null);
  usePendingSave(
    '裁剪恢复副本',
    () => pending.current ?? Promise.resolve(true),
  );
  const perform = (operation: () => Promise<void>) => {
    if (pending.current) return;
    setBusy(true);
    setNotice(null);
    const task = operation()
      .then(() => true)
      .catch((reason: unknown) => {
        setNotice(projectErrorMessage(reason));
        return false;
      })
      .finally(() => {
        pending.current = null;
        setBusy(false);
      });
    pending.current = task;
  };
  if (!error && !notice) return null;
  return (
    <section
      aria-label="裁剪恢复保护"
      className="border-b bg-warning px-6 py-3 text-sm text-warning-foreground"
    >
      {error && <p role="alert">{error}</p>}
      {notice && (
        <p role="status" className="break-all">
          {notice}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-2">
        {error && controller.canRetryProtection() && (
          <Button
            size="sm"
            variant="outline"
            disabled={busy}
            onClick={() =>
              perform(async () => {
                if (await controller.retryProtection())
                  setNotice('裁剪恢复副本已更新。未保存的裁剪仍需重试保存。');
              })
            }
          >
            重试保护裁剪
          </Button>
        )}
        {error &&
          controller.snapshots().map((snapshot, index) => (
            <Button
              key={snapshot.sessionId}
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() =>
                perform(async () => {
                  const path = await window.desktop.exportProjectEditDraft(
                    projectId,
                    { snapshot },
                  );
                  if (path) setNotice(`只读裁剪恢复文件已保存：${path}`);
                })
              }
            >
              导出裁剪恢复文件{index > 0 ? ` ${index + 1}` : ''}
            </Button>
          ))}
        {notice && (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => setNotice(null)}
          >
            关闭提示
          </Button>
        )}
      </div>
    </section>
  );
}
