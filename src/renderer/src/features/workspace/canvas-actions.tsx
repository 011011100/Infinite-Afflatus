import { Trash2, Ungroup } from 'lucide-react';
import { HistoryActions } from '@/components/canvas/history-actions';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  formatShortcut,
  type Shortcuts,
} from '../../../../shared/interaction/shortcuts';

export function CanvasActions({
  disabled,
  canUndo,
  canRedo,
  canSplit,
  canRemove = false,
  undo,
  redo,
  split,
  remove,
  shortcuts,
  isMac,
}: {
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSplit: boolean;
  canRemove?: boolean;
  undo: () => void;
  redo: () => void;
  split: () => void;
  remove?: () => void;
  shortcuts: Shortcuts;
  isMac: boolean;
}) {
  return (
    <fieldset
      className="flex items-center gap-1 rounded-xl border bg-background/95 p-1.5 shadow-sm"
      aria-label="画布操作"
    >
      <HistoryActions
        {...{ disabled, canUndo, canRedo, undo, redo, shortcuts, isMac }}
      />
      {canRemove && remove && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  aria-label="移除镜头"
                  disabled={disabled}
                  onClick={remove}
                />
              }
            >
              <Trash2 />
              移除镜头
            </TooltipTrigger>
            <TooltipContent>
              从主画布移除镜头；素材文件保留，可在本次项目会话中撤销
            </TooltipContent>
          </Tooltip>
        </>
      )}
      {canSplit && (
        <>
          <span className="mx-1 h-4 w-px bg-border" />
          <Tooltip>
            <TooltipTrigger
              disabled={disabled}
              render={
                <Button variant="ghost" disabled={disabled} onClick={split} />
              }
            >
              <Ungroup />
              拆分选中片段
            </TooltipTrigger>
            <TooltipContent>
              拆出选中片段，前后各自保留连续组合
              {shortcuts.split &&
                ` · ${formatShortcut(shortcuts.split, isMac)}`}
            </TooltipContent>
          </Tooltip>
        </>
      )}
    </fieldset>
  );
}
