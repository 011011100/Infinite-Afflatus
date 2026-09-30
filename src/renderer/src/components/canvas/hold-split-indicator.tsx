import { Check, Ungroup } from 'lucide-react';
import {
  HOLD_HINT_DELAY_MS,
  LONG_PRESS_MS,
} from '../../../../shared/interaction/long-press';

export function HoldSplitIndicator({ ready }: { ready: boolean }) {
  return (
    <span className="pointer-events-none absolute inset-0 grid place-items-center">
      <span>
        <span
          data-ready={ready}
          className="hold-split-indicator relative block size-16 rounded-full bg-background/95 text-primary shadow-lg ring-1 ring-white/70"
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 64 64"
            className="absolute inset-0 size-full -rotate-90"
            fill="none"
            strokeWidth="4"
          >
            <circle cx="32" cy="32" r="27" className="stroke-primary/15" />
            <circle
              cx="32"
              cy="32"
              r="27"
              pathLength="100"
              strokeDasharray="100"
              strokeLinecap="round"
              className="hold-split-progress stroke-primary"
              style={{
                animationDuration: `${LONG_PRESS_MS - HOLD_HINT_DELAY_MS}ms`,
              }}
            />
          </svg>
          <span className="absolute inset-3 grid place-items-center rounded-full bg-primary/10">
            <span
              className="t-icon-swap"
              data-state={ready ? 'b' : 'a'}
              aria-hidden="true"
            >
              <span className="t-icon grid place-items-center" data-icon="a">
                <Ungroup size={20} />
              </span>
              <span className="t-icon grid place-items-center" data-icon="b">
                <Check size={22} strokeWidth={2.5} />
              </span>
            </span>
          </span>
        </span>
      </span>
      <span role="status" className="sr-only">
        {ready ? '松开拆分，移动取消' : '长按以拆出卡片'}
      </span>
    </span>
  );
}
