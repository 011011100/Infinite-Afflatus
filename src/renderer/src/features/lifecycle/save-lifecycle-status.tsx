import { LoaderCircle } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';

export function SaveLifecycleStatus({
  saving,
  error,
  retry,
}: {
  saving: boolean;
  error: string | null;
  retry: () => Promise<boolean>;
}) {
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!saving) return;
    const previous = [...document.body.children]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== overlay.current,
      )
      .map((element) => ({ element, inert: element.inert }));
    for (const { element } of previous) element.inert = true;
    overlay.current?.focus();
    return () => {
      for (const { element, inert } of previous) element.inert = inert;
    };
  }, [saving]);
  if (saving)
    return createPortal(
      <div
        ref={overlay}
        data-save-before-leave
        tabIndex={-1}
        className="fixed inset-0 z-[1000] grid place-items-center bg-background/70 outline-none"
        role="status"
        aria-live="polite"
        onKeyDownCapture={(event) => event.stopPropagation()}
      >
        <p className="flex items-center gap-2 rounded-xl border bg-background px-5 py-4 text-sm shadow-sm">
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          正在保存修改，请稍候…
        </p>
      </div>,
      document.body,
    );
  if (!error) return null;
  return createPortal(
    <div
      className="fixed left-1/2 top-16 z-[1000] flex max-w-[90vw] -translate-x-1/2 items-center gap-3 rounded-xl border bg-warning px-4 py-3 text-sm text-warning-foreground shadow-sm"
      role="alert"
    >
      <span>{error}</span>
      <Button variant="outline" size="sm" onClick={() => void retry()}>
        重试保存
      </Button>
    </div>,
    document.body,
  );
}
