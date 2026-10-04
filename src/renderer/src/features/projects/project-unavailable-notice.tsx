import { LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { ProjectUnavailable } from './library-session';

export function ProjectUnavailableNotice({
  state,
  retry,
  openSettings,
  migrating,
}: {
  state: ProjectUnavailable;
  retry: () => Promise<boolean>;
  openSettings: () => void;
  migrating: boolean;
}) {
  return (
    <aside
      role="alert"
      className="shrink-0 border-b bg-warning px-5 py-3 text-sm text-warning-foreground"
      data-project-unavailable
    >
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="font-medium">
            {state.conflict
              ? '项目内容已变化，仍暂停保存'
              : '项目读取或保存失败，已暂停编辑与保存'}
          </p>
          <p className="mt-1 text-xs leading-5">
            当前窗口保留上次读取的画面、未保存输入和撤销记录。请保持窗口打开，恢复原项目文件后重试。
          </p>
          <p className="mt-1 max-h-20 overflow-auto break-words text-xs">
            {state.message}
          </p>
          {state.lastVerifiedAt && (
            <p className="mt-1 text-xs opacity-70">
              上次确认项目可读取：
              {new Date(state.lastVerifiedAt).toLocaleTimeString()}
            </p>
          )}
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={state.retrying || migrating}
          onClick={() => void retry()}
        >
          {state.retrying && <LoaderCircle className="size-3 animate-spin" />}
          {state.retrying ? '正在检查…' : '重试读取项目'}
        </Button>
        <Button variant="ghost" size="sm" onClick={openSettings}>
          查看保存目录
        </Button>
      </div>
    </aside>
  );
}
