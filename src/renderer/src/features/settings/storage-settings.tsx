import { FolderOpen } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { LibraryState, MigrationPreview } from '../../../../shared/models';

const phaseLabels = {
  copying: '正在复制项目',
  verifying: '正在校验文件',
  cleaning: '正在清理旧副本',
  completed: '迁移完成',
  failed: '迁移未完成',
  cancelled: '迁移已取消',
};
export function StorageSettings({
  library,
  onClose,
  run,
  error,
}: {
  library: LibraryState;
  onClose: () => void;
  run: (operation: () => Promise<unknown>) => Promise<void>;
  error: string | null;
}) {
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const [choosing, setChoosing] = useState(false);
  const migration = library.migration;
  const choose = () =>
    run(async () => {
      setChoosing(true);
      try {
        setPreview(await window.desktop.chooseDirectory());
      } finally {
        setChoosing(false);
      }
    });
  return (
    <Modal title="保存与存储" onClose={onClose} error={error}>
      <p className="text-sm font-medium">项目保存目录</p>
      <p className="mt-2 text-sm leading-6 text-muted-foreground">
        所有项目统一保存在这里。修改目录时，已有项目会一起迁移。
      </p>
      <div className="my-4 break-all rounded-lg border bg-canvas p-3 text-sm">
        {library.root}
      </div>
      <div className="flex gap-2">
        <Button
          variant="outline"
          onClick={() => {
            void run(() => window.desktop.revealRoot());
          }}
        >
          <FolderOpen />
          打开文件夹
        </Button>
        <Button
          variant="outline"
          disabled={
            choosing || library.writeBlocked || migration?.phase === 'cleaning'
          }
          onClick={() => {
            void choose();
          }}
        >
          {choosing ? '正在检查目录…' : '修改保存目录'}
        </Button>
      </div>
      {preview && (
        <section className="mt-6 rounded-lg border border-primary/20 bg-accent p-4">
          <h3 className="text-sm font-medium">迁移到新目录</h3>
          <p className="mt-2 break-all text-xs text-muted-foreground">
            {preview.target}
          </p>
          <p className="mt-3 text-sm">
            {preview.projectCount} 个项目 ·{' '}
            {(preview.bytes / 1024 ** 2).toFixed(1)} MB
          </p>
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            校验完成后切换目录，并清理原位置的项目副本。你自行放入的其他文件会保留。迁移期间，接收到的结果会先暂存。
          </p>
          <div className="mt-4 flex gap-2">
            <Button
              disabled={library.writeBlocked}
              onClick={() => {
                void run(async () => {
                  await window.desktop.startMigration(preview.token);
                  setPreview(null);
                });
              }}
            >
              开始迁移
            </Button>
            <Button variant="ghost" onClick={() => setPreview(null)}>
              取消
            </Button>
          </div>
        </section>
      )}
      {migration && (
        <section className="mt-6 border-t pt-5" aria-live="polite">
          <div className="flex items-center justify-between text-sm">
            <h3 className="font-medium">{phaseLabels[migration.phase]}</h3>
            <span className="text-muted-foreground">
              {migration.copied} / {migration.total} 个文件
            </span>
          </div>
          {library.writeBlocked && (
            <progress
              className="mt-3 h-1.5 w-full accent-primary"
              value={migration.copied}
              max={Math.max(migration.total, 1)}
            />
          )}
          {migration.error && (
            <p className="mt-3 text-xs leading-5 text-destructive">
              {migration.error}
            </p>
          )}
          {migration.warnings.map((warning) => (
            <p
              key={warning}
              className="mt-2 break-all text-xs leading-5 text-muted-foreground"
            >
              {warning}
            </p>
          ))}
          {['copying', 'verifying'].includes(migration.phase) && (
            <Button
              variant="ghost"
              className="mt-3"
              onClick={() => {
                void run(() => window.desktop.cancelMigration());
              }}
            >
              取消迁移
            </Button>
          )}
          {migration.phase === 'cleaning' && !library.writeBlocked && (
            <Button
              variant="outline"
              className="mt-3"
              onClick={() => {
                void run(() => window.desktop.retryCleanup());
              }}
            >
              重试清理旧副本
            </Button>
          )}
          {migration.phase === 'completed' && (
            <p className="mt-2 text-xs text-muted-foreground">
              后续项目和生成结果都会保存到新目录。
            </p>
          )}
        </section>
      )}
      <p className="mt-8 text-xs leading-5 text-muted-foreground">
        暂存文件与项目目录分开保存。只有项目保存成功后，才会清除对应的暂存结果。
      </p>
    </Modal>
  );
}
