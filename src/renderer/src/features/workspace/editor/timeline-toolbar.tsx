import { Minus, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 6;
const ZOOM_STEP = 0.25;

export function TimelineToolbar({
  zoom,
  zoomDisabled,
  onZoomChange,
  restoreDisabled,
  onRestore,
}: {
  zoom: number;
  zoomDisabled: boolean;
  onZoomChange: (zoom: number) => void;
  restoreDisabled: boolean;
  onRestore: () => void;
}) {
  return (
    <div className="flex items-center gap-3 text-xs text-muted-foreground">
      <Button
        variant="outline"
        size="sm"
        disabled={restoreDisabled}
        onClick={onRestore}
      >
        恢复原片
      </Button>
      <fieldset aria-label="轨道缩放" className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="缩小轨道"
          title="缩小轨道"
          disabled={zoomDisabled || zoom <= MIN_ZOOM}
          onClick={() => onZoomChange(Math.max(MIN_ZOOM, zoom - ZOOM_STEP))}
        >
          <Minus />
        </Button>
        <span className="w-10 text-center tabular-nums" aria-live="polite">
          {Math.round(zoom * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="放大轨道"
          title="放大轨道"
          disabled={zoomDisabled || zoom >= MAX_ZOOM}
          onClick={() => onZoomChange(Math.min(MAX_ZOOM, zoom + ZOOM_STEP))}
        >
          <Plus />
        </Button>
      </fieldset>
    </div>
  );
}
