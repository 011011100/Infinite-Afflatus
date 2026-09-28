import { X } from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef } from 'react';
import { Button } from './button';

export function Modal({
  title,
  children,
  onClose,
  wide = false,
  error,
}: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
  error?: string | null;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={onClose}
      onClose={onClose}
      className={`m-auto max-h-[88vh] overflow-y-auto rounded-xl border bg-background p-0 text-foreground shadow-xl backdrop:bg-slate-950/25 ${wide ? 'w-[min(1000px,90vw)]' : 'w-[min(620px,90vw)]'}`}
    >
      <header className="flex items-center justify-between gap-4 border-b px-6 py-4">
        <h2 id={titleId} className="text-base font-semibold">
          {title}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="关闭"
          onClick={onClose}
        >
          <X />
        </Button>
      </header>
      <div className="p-6">
        {error && (
          <p
            role="alert"
            className="mb-4 break-words rounded-lg bg-warning p-3 text-sm text-warning-foreground"
          >
            {error}
          </p>
        )}
        {children}
      </div>
    </dialog>
  );
}
