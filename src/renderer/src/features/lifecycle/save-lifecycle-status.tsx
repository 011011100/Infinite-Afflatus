import { LoaderCircle } from 'lucide-react';
import { useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { acquireInert } from '@/lib/inert-lease';
import { getModalHost, subscribeModalHosts } from '@/lib/modal-hosts';

export function SaveLifecycleStatus({
  saving,
  error,
  retry,
}: {
  saving: boolean;
  error: string | null;
  retry: () => Promise<boolean>;
}) {
  const overlay = useRef<HTMLDialogElement>(null);
  const modalHost = useSyncExternalStore(subscribeModalHosts, getModalHost);
  useLayoutEffect(() => {
    const dialog = overlay.current;
    if (!saving || !dialog) return;
    const releases = [...document.body.children]
      .filter(
        (element): element is HTMLElement =>
          element instanceof HTMLElement && element !== dialog,
      )
      .map(acquireInert);
    // An ordinary overlay cannot block an existing showModal() dialog. The save
    // guard must itself own the top layer until this attempt releases editing.
    const keepSaving = (event: Event) => event.preventDefault();
    dialog.addEventListener('cancel', keepSaving);
    dialog.showModal();
    dialog.focus();
    return () => {
      for (const release of releases) release();
      dialog.close();
      dialog.removeEventListener('cancel', keepSaving);
    };
  }, [saving]);
  if (saving)
    return createPortal(
      <dialog
        ref={overlay}
        data-save-before-leave
        closedby="none"
        tabIndex={-1}
        className="fixed inset-0 m-0 grid h-dvh max-h-none w-dvw max-w-none place-items-center border-0 bg-background/70 p-0 text-foreground outline-none backdrop:bg-transparent"
        aria-label="正在保存修改"
        onKeyDownCapture={(event) => {
          // CloseWatcher cancel events can be non-cancelable. Consume Escape
          // before it can close this guard or an editor underneath it.
          if (event.key === 'Escape') event.preventDefault();
          event.stopPropagation();
        }}
      >
        <p
          role="status"
          aria-live="polite"
          className="flex items-center gap-2 rounded-xl border bg-background px-5 py-4 text-sm shadow-sm"
        >
          <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          正在保存修改，请稍候…
        </p>
      </dialog>,
      document.body,
    );
  if (!error) return null;
  return createPortal(
    <div
      className={`flex items-center gap-3 rounded-xl border bg-warning px-4 py-3 text-sm text-warning-foreground shadow-sm ${modalHost ? 'w-full' : 'fixed left-1/2 top-16 z-[1000] max-w-[90vw] -translate-x-1/2'}`}
      role="alert"
    >
      <span className="min-w-0 break-words">{error}</span>
      <Button
        data-save-retry
        variant="outline"
        size="sm"
        className="shrink-0"
        onClick={() => void retry()}
      >
        重试保存
      </Button>
    </div>,
    modalHost?.host ?? document.body,
  );
}
