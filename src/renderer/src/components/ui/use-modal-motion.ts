import { type RefObject, useEffect, useRef } from 'react';
import { instantMotion } from '@/lib/input-method';

export function useModalMotion(
  ref: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
  onCloseStart?: () => void,
  beforeClose?: () => Promise<boolean>,
) {
  const closing = useRef(false);
  const checking = useRef(false);
  const epoch = useRef(0);
  const closeCallback = useRef(onClose);
  const checkClose = useRef(beforeClose);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  closeCallback.current = onClose;
  checkClose.current = beforeClose;

  useEffect(() => {
    const modal = ref.current;
    if (!modal) return;
    modal.dataset.instant = String(instantMotion());
    closing.current = false;
    checking.current = false;
    modal.inert = false;
    modal.showModal();
    // Establish the initial scale/opacity before applying the open state.
    void modal.offsetWidth;
    const frame = requestAnimationFrame(() => {
      if (!closing.current) modal.classList.add('is-open');
    });
    return () => {
      epoch.current++;
      checking.current = false;
      cancelAnimationFrame(frame);
      clearTimeout(timer.current);
    };
  }, [ref]);

  const close = () => {
    const modal = ref.current;
    if (!modal || closing.current) return;
    closing.current = true;
    modal.inert = true;
    onCloseStart?.();
    // Stop media immediately even when the surface is still fading out.
    modal
      .querySelectorAll<HTMLMediaElement>('video, audio')
      .forEach((media) => {
        media.pause();
      });
    const instant = instantMotion();
    modal.dataset.instant = String(instant);
    modal.classList.remove('is-open');
    modal.classList.add('is-closing');
    const finish = () => {
      modal.classList.remove('is-closing');
      closeCallback.current();
    };
    if (instant) {
      finish();
      return;
    }
    const closeMs =
      parseFloat(
        getComputedStyle(modal).getPropertyValue('--modal-close-dur'),
      ) || 150;
    timer.current = setTimeout(finish, closeMs);
  };
  return () => {
    const modal = ref.current;
    if (!modal || closing.current || checking.current) return;
    const check = checkClose.current;
    if (!check) {
      close();
      return;
    }
    checking.current = true;
    const request = epoch.current;
    // Keep the dialog interactive if its owner cannot safely finish or discard
    // an edit. Only a successful check starts the existing close animation.
    void Promise.resolve()
      .then(check)
      .then((allowed) => {
        if (
          allowed &&
          request === epoch.current &&
          modal === ref.current &&
          modal.isConnected
        )
          close();
      })
      .catch(() => {
        // The owner displays its operation error; a rejected guard never closes.
      })
      .finally(() => {
        if (request === epoch.current) checking.current = false;
      });
  };
}
