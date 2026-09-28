import { type RefObject, useEffect, useRef } from 'react';
import { instantMotion } from '@/lib/input-method';

export function useModalMotion(
  ref: RefObject<HTMLDialogElement | null>,
  onClose: () => void,
  onCloseStart?: () => void,
) {
  const closing = useRef(false);
  const closeCallback = useRef(onClose);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  closeCallback.current = onClose;

  useEffect(() => {
    const modal = ref.current;
    if (!modal) return;
    modal.dataset.instant = String(instantMotion());
    modal.showModal();
    // Establish the initial scale/opacity before applying the open state.
    void modal.offsetWidth;
    const frame = requestAnimationFrame(() => {
      if (!closing.current) modal.classList.add('is-open');
    });
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer.current);
    };
  }, [ref]);

  return () => {
    const modal = ref.current;
    if (!modal || closing.current) return;
    closing.current = true;
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
}
