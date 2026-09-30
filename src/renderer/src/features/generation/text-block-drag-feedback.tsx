import { Check, GripVertical, Ungroup } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { HoldProgress } from '@/components/ui/hold-progress';
import type { HeldBlock, LiftedBlock } from './use-text-block-drag';
import './text-block-drag-feedback.css';

/** Render inside the dialog's top layer; a body portal would be hidden by it. */
export function TextBlockHoldFeedback({
  hold,
  liftedId,
}: {
  hold: HeldBlock | null;
  liftedId: string | undefined;
}) {
  const last = useRef<HeldBlock | null>(null);
  const motion = useRef<HTMLSpanElement>(null);
  const [hidden, setHidden] = useState(false);
  if (hold) last.current = hold;
  const key = hold ? `${hold.id}:${hold.startedAt}` : null;
  useEffect(() => {
    if (key) {
      setHidden(false);
      return;
    }
    let current = true;
    const animations = motion.current?.getAnimations() ?? [];
    void Promise.allSettled(animations.map((a) => a.finished)).then(() => {
      if (current) setHidden(true);
    });
    return () => {
      current = false;
    };
  }, [key]);
  const view = hold ?? (hidden ? null : last.current);
  if (!view) return null;
  return (
    <span
      key={`${view.id}:${view.startedAt}`}
      className="text-block-hold"
      style={{ left: view.x, top: view.y }}
    >
      <span
        ref={motion}
        className="hold-feedback relative block size-full"
        data-open={!!hold}
      >
        <HoldProgress
          ready={liftedId === view.id}
          duration={view.duration}
          icon={<GripVertical size={20} />}
          label={liftedId === view.id ? '已拿起文本块' : '长按以拿起文本块'}
        />
      </span>
    </span>
  );
}

export function TextBlockDropFeedback({
  lifted,
  returned,
  onViewCanvas,
}: {
  lifted: LiftedBlock | null;
  returned: number;
  onViewCanvas: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    setVisible(returned > 0);
    if (!returned) return;
    const timeout = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timeout);
  }, [returned]);
  const complete = !lifted && visible;
  return (
    <div
      className="text-block-drop-feedback"
      data-open={!!lifted || complete}
      data-outside={!!lifted?.outside}
      data-complete={complete}
      aria-hidden={!lifted && !complete}
    >
      <span className="flex items-center gap-2" role="status">
        {complete ? <Check size={16} /> : <Ungroup size={16} />}
        {complete
          ? '已移回画布'
          : lifted?.outside
            ? '松手移回画布'
            : '拖出文本区，移回画布'}
      </span>
      {complete && (
        <Button size="xs" variant="ghost" onClick={onViewCanvas}>
          查看
        </Button>
      )}
    </div>
  );
}
