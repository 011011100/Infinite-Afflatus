import { Redo2, Undo2, Ungroup } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function CanvasActions({
  disabled,
  canUndo,
  canRedo,
  canSplit,
  undo,
  redo,
  split,
}: {
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  canSplit: boolean;
  undo: () => void;
  redo: () => void;
  split: () => void;
}) {
  return (
    <fieldset
      className="flex items-center gap-1 rounded-xl border bg-background/95 p-1.5 shadow-sm"
      aria-label="画布操作"
    >
      <Tooltip>
        <TooltipTrigger
          disabled={disabled || !canUndo}
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled || !canUndo}
              aria-label="撤销"
              onClick={undo}
            />
          }
        >
          <Undo2 />
        </TooltipTrigger>
        <TooltipContent>撤销 · ⌘ / Ctrl Z</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          disabled={disabled || !canRedo}
          render={
            <Button
              variant="ghost"
              size="icon"
              disabled={disabled || !canRedo}
              aria-label="重做"
              onClick={redo}
            />
          }
        >
          <Redo2 />
        </TooltipTrigger>
        <TooltipContent>重做 · ⌘ / Ctrl Shift Z</TooltipContent>
      </Tooltip>
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
            <TooltipContent>拆出选中片段，前后各自保留连续组合</TooltipContent>
          </Tooltip>
        </>
      )}
    </fieldset>
  );
}
