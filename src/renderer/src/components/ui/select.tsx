import { ChevronDown } from 'lucide-react';
import type { ComponentProps } from 'react';
import { cn } from '@/lib/utils';

export function Select({
  className,
  children,
  ...props
}: ComponentProps<'select'>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={cn(
          'h-10 w-full appearance-none rounded-lg border bg-background pl-3 pr-9 text-sm outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/15 disabled:opacity-50',
          className,
        )}
      >
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-3 top-3 size-4 text-muted-foreground" />
    </div>
  );
}
