import { ContextMenu as Primitive } from '@base-ui/react/context-menu';
import type { ComponentProps } from 'react';
import { instantMotion } from '@/lib/input-method';
import { cn } from '@/lib/utils';

export const ContextMenu = Primitive.Root;
export const ContextMenuTrigger = Primitive.Trigger;
export function ContextMenuContent({
  className,
  ...props
}: ComponentProps<typeof Primitive.Popup>) {
  return (
    <Primitive.Portal>
      <Primitive.Positioner className="z-[80]" sideOffset={4}>
        <Primitive.Popup
          className={(state) =>
            cn(
              't-context-menu min-w-44 rounded-xl border bg-popover p-1.5 text-sm text-popover-foreground shadow-xl outline-none',
              instantMotion() && 't-motion-instant',
              typeof className === 'function' ? className(state) : className,
            )
          }
          {...props}
        />
      </Primitive.Positioner>
    </Primitive.Portal>
  );
}
export function ContextMenuItem({
  className,
  ...props
}: ComponentProps<typeof Primitive.Item>) {
  return (
    <Primitive.Item
      className={cn(
        'flex cursor-default items-center gap-2 rounded-md px-3 py-2 outline-none data-[highlighted]:bg-accent data-[disabled]:opacity-40 [&_svg]:size-4',
        className,
      )}
      {...props}
    />
  );
}
