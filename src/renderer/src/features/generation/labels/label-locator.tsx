import { Panel, useStore, useViewport } from '@xyflow/react';
import { ArrowUp, Navigation } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { isMac } from '@/lib/platform';
import type { CanvasLabel } from '../../../../../shared/generation/workspace';
import {
  formatShortcut,
  type Shortcut,
} from '../../../../../shared/interaction/shortcuts';
import { labelMarkers } from './geometry';

const editable = (target: EventTarget | null) =>
  target instanceof Element &&
  !!target.closest(
    'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]',
  );
export function LabelLocator({
  labels,
  shortcut,
  held,
  disabled,
  jump,
  cancel,
}: {
  labels: CanvasLabel[];
  shortcut: Shortcut | null;
  held: boolean;
  disabled: boolean;
  jump: (label: CanvasLabel) => void;
  cancel: () => void;
}) {
  const viewport = useViewport();
  const width = useStore((state) => state.width);
  const height = useStore((state) => state.height);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (disabled) {
      setOpen(false);
      return;
    }
    const reset = () => {
      setOpen(false);
    };
    const down = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        reset();
        cancel();
        return;
      }
    };
    const focus = (event: FocusEvent) => {
      if (editable(event.target)) reset();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('blur', reset);
    window.addEventListener('focusin', focus);
    document.addEventListener('visibilitychange', reset);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('blur', reset);
      window.removeEventListener('focusin', focus);
      document.removeEventListener('visibilitychange', reset);
    };
  }, [disabled, cancel]);
  return (
    <>
      <Panel position="top-right">
        <Button
          variant="outline"
          size="icon"
          className="bg-background shadow-sm"
          disabled={disabled || !labels.length}
          title={
            shortcut
              ? `按住 ${formatShortcut(shortcut, isMac)} 定位标签`
              : '定位标签'
          }
          aria-label="定位标签"
          aria-pressed={open || held}
          onClick={() => setOpen(!open)}
        >
          <Navigation />
        </Button>
      </Panel>
      {!disabled && (held || open) && (
        <nav
          className="label-locator pointer-events-none absolute inset-0 z-40"
          aria-label="标签位置"
        >
          {labelMarkers(labels, viewport, { width, height }).map((marker) => (
            <button
              key={marker.label.id}
              type="button"
              className="label-marker nodrag nopan pointer-events-auto absolute flex h-7 w-max max-w-32 items-center gap-1.5 rounded-full border bg-background px-2.5 text-xs shadow-sm"
              aria-label={`跳转到标签：${marker.label.name}`}
              title={marker.label.name}
              data-label-id={marker.label.id}
              data-edge={marker.edge ?? 'visible'}
              style={{
                left: marker.x,
                top: marker.y,
                borderColor: marker.label.color,
                transform: 'translate(-50%, -50%)',
              }}
              onClick={() => {
                setOpen(false);
                jump(marker.label);
              }}
            >
              <span
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: marker.label.color }}
              />
              <span className="min-w-0 flex-1 truncate text-left">
                {marker.label.name}
              </span>
              {marker.edge && (
                <ArrowUp
                  aria-hidden="true"
                  className="label-marker-arrow pointer-events-none absolute size-3.5"
                  style={{
                    color: marker.label.color,
                    transform: `rotate(${marker.angle}deg)`,
                  }}
                />
              )}
            </button>
          ))}
        </nav>
      )}
    </>
  );
}
