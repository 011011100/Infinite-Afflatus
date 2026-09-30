import { rulerStep } from './timeline';

const tickGradient =
  'linear-gradient(to right, var(--border) 1px, transparent 1px)';

function formatRulerTick(time: number): string {
  if (time < 60) return `${time}s`;
  const minutes = Math.floor(time / 60);
  const seconds = time % 60;
  return `${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
}

/** Decorative marks share the clips' time origin; seeking stays on the track. */
export function TimelineRuler({
  duration,
  origin,
  scale,
}: {
  duration: number;
  origin: number;
  scale: number;
}) {
  const step = rulerStep(scale);
  const spacing = step * scale;
  // Keep small marks at least 10px apart as the timeline zoom changes.
  const divisions = spacing >= 100 ? 10 : 5;
  const ticks = Array.from(
    { length: Math.floor(duration / step) + 1 },
    (_, index) => index * step,
  );
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute inset-y-0 overflow-hidden"
      style={{ left: origin * scale, width: duration * scale }}
    >
      {/* Repeat the fine marks in CSS instead of adding a DOM node per tick. */}
      <span
        className="absolute inset-x-0 bottom-0 h-1.5"
        style={{
          backgroundImage: tickGradient,
          backgroundSize: `${spacing / divisions}px 100%`,
        }}
      />
      {divisions === 10 && (
        <span
          className="absolute inset-x-0 bottom-0 h-2.5"
          style={{
            backgroundImage: tickGradient,
            backgroundSize: `${spacing / 2}px 100%`,
          }}
        />
      )}
      {ticks.map((tick) => (
        <span
          key={tick}
          className="absolute bottom-0 h-6 border-l border-border text-[10px] tabular-nums text-muted-foreground"
          style={{ left: tick * scale }}
        >
          <span className="relative -top-1 ml-1.5">
            {formatRulerTick(tick)}
          </span>
        </span>
      ))}
    </span>
  );
}
