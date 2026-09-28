import { Panel, useReactFlow, useStore } from '@xyflow/react';
import { MinusIcon, PlusIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

export function CanvasControls() {
  const { zoomIn, zoomOut } = useReactFlow();
  const canZoomIn = useStore((state) => state.transform[2] < state.maxZoom);
  const canZoomOut = useStore((state) => state.transform[2] > state.minZoom);

  return (
    <Panel position="bottom-right" className="nodrag nopan">
      <fieldset
        aria-label="画布缩放"
        className="flex items-center gap-0.5 rounded-lg border bg-background p-0.5 text-muted-foreground"
      >
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon" disabled={!canZoomIn} />
            }
            aria-label="放大画布"
            disabled={!canZoomIn}
            onClick={() => void zoomIn()}
          >
            <PlusIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>放大画布</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button variant="ghost" size="icon" disabled={!canZoomOut} />
            }
            aria-label="缩小画布"
            disabled={!canZoomOut}
            onClick={() => void zoomOut()}
          >
            <MinusIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipContent sideOffset={8}>缩小画布</TooltipContent>
        </Tooltip>
      </fieldset>
    </Panel>
  );
}
