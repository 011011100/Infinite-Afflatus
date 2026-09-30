import { instantMotion } from '@/lib/input-method';
import { cn } from '@/lib/utils';
import { Button } from './button';

export function SegmentedControl<Value extends string>({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: Value;
  options: {
    value: Value;
    label: string;
    disabled?: boolean;
    title?: string | undefined;
  }[];
  onChange: (value: Value) => void;
  label: string;
  className?: string;
}) {
  const index = options.findIndex((option) => option.value === value);
  return (
    <fieldset
      aria-label={label}
      className={cn(
        't-segmented relative grid rounded-lg bg-secondary p-1',
        className,
      )}
      data-instant={instantMotion()}
      style={{
        gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))`,
      }}
    >
      <span className="pointer-events-none absolute inset-1" aria-hidden="true">
        <span
          className="t-segmented-indicator block h-full rounded-md bg-background shadow-sm"
          style={{
            width: `${100 / options.length}%`,
            transform: `translateX(${Math.max(0, index) * 100}%)`,
            opacity: index < 0 ? 0 : 1,
          }}
        />
      </span>
      {options.map((option) => (
        <Button
          key={option.value}
          size="sm"
          variant="ghost"
          className={cn(
            'relative min-w-0 px-1 text-xs hover:bg-transparent active:translate-y-0',
            value === option.value && 'text-primary hover:text-primary',
          )}
          aria-pressed={value === option.value}
          disabled={option.disabled}
          title={option.title}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </Button>
      ))}
    </fieldset>
  );
}
