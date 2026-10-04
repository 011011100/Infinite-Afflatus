import { Ungroup } from 'lucide-react';
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
  undo,
  redo,
  split,
  shortcuts,
  isMac,
}: {
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSplit: boolean;
  undo: () => void;
  redo: () => void;
  split: () => void;
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
