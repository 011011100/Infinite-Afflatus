import { Check } from 'lucide-react';
import type { ReactNode } from 'react';

/** Shared visual language for holding to split a card or pick up a text block. */
export function HoldProgress({
  ready,
  duration,
  icon,
  label,
}: {
  ready: boolean;
  duration: number;
  icon: ReactNode;
  label: string;
}) {
  return (
    <span className="pointer-events-none absolute inset-0 grid place-items-center">
      <span
        data-ready={ready}
        className="hold-indicator relative block size-full rounded-full bg-background/95 text-primary shadow-lg ring-1 ring-white/70"
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
            className="hold-progress stroke-primary"
            style={{ animationDuration: `${duration}ms` }}
          />
        </svg>
        <span className="absolute inset-[18.75%] grid place-items-center rounded-full bg-primary/10">
          <span
            className="t-icon-swap"
            data-state={ready ? 'b' : 'a'}
            aria-hidden="true"
          >
            <span className="t-icon grid place-items-center" data-icon="a">
              {icon}
            </span>
            <span className="t-icon grid place-items-center" data-icon="b">
              <Check size={22} strokeWidth={2.5} />
            </span>
          </span>
        </span>
      </span>
      <span role="status" className="sr-only">
        {label}
      </span>
    </span>
  );
}
