import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import type { useProjectRename } from './use-project-rename';

export function ProjectRenameDialog({
  rename,
  unavailableNotice,
}: {
  rename: ReturnType<typeof useProjectRename>;
  unavailableNotice?: ReactNode;
}) {
  const editor = rename.editor;
  if (!editor) return null;
  return (
    <Modal
      title="修改项目名称"
      onClose={rename.close}
      beforeClose={rename.beforeClose}
      error={rename.error}
    >
      {(requestClose) => (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void rename.save().then((saved) => {
              if (saved) requestClose();
            });
          }}
        >
          {unavailableNotice}
          {editor.restored && (
            <p className="mb-3 text-sm text-muted-foreground">
              已恢复名称输入，点击保存后才会修改项目名称。
            </p>
          )}
          {rename.conflict && (
            <p role="alert" className="mb-3 text-sm text-warning-foreground">
              项目名称与草稿对应的原名称不同。输入和恢复副本已保留，可导出恢复文件或取消本次修改。
            </p>
          )}
          <Input
            aria-label="项目名称"
            value={editor.target}
            maxLength={100}
            readOnly={rename.readOnly}
            onChange={(event) => rename.setValue(event.target.value)}
          />
          {rename.protectionError && (
            <p role="alert" className="mt-3 text-sm text-warning-foreground">
              {rename.protectionError}
            </p>
          )}
          {(rename.error ||
            rename.protectionError ||
            rename.conflict ||
            (rename.readOnly && !rename.busy)) && (
            <div className="mt-3 flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={rename.busy}
                onClick={() => void rename.exportDraft()}
              >
                导出名称恢复文件
              </Button>
              {rename.protectionError && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={rename.busy || editor.protecting}
                  onClick={() => void rename.retryProtection()}
                >
                  重试保护名称
                </Button>
              )}
            </div>
          )}
          {editor.notice && (
            <p
              role="status"
              className="mt-3 break-all text-xs text-muted-foreground"
            >
              {editor.notice}
            </p>
          )}
          <div className="mt-5 flex justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={rename.busy}
              onClick={requestClose}
            >
              取消
            </Button>
            <Button
              type="submit"
              disabled={
                !rename.canSave || rename.conflict || !editor.target.trim()
              }
            >
              {editor.busy === 'saving'
                ? '保存中…'
                : rename.saved
                  ? '重试更新项目'
                  : '保存'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}
