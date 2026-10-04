import { Redo2, Undo2 } from 'lucide-react';
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

export function HistoryActions({
  disabled,
  canUndo,
  canRedo,
  undo,
  redo,
  shortcuts,
  isMac,
}: {
  disabled: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  shortcuts: Pick<Shortcuts, 'undo' | 'redo'>;
  isMac: boolean;
}) {
  return (
    <>
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
        <TooltipContent>
          撤销{shortcuts.undo && ` · ${formatShortcut(shortcuts.undo, isMac)}`}
        </TooltipContent>
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
        <TooltipContent>
          重做{shortcuts.redo && ` · ${formatShortcut(shortcuts.redo, isMac)}`}
        </TooltipContent>
      </Tooltip>
    </>
  );
}
