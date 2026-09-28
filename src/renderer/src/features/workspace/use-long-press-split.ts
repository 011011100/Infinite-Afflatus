import {
  type PointerEvent as ReactPointerEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import {
  HOLD_HINT_DELAY_MS,
  LONG_PRESS_MS,
  LongPress,
} from '../../../../shared/interaction/long-press';

export function useLongPressSplit(
  enabled: boolean,
  select: () => void,
  split: () => void,
) {
  const [phase, setPhase] = useState<'idle' | 'holding' | 'ready'>('idle');
  const gesture = useRef(new LongPress());
  const cleanup = useRef<() => void>(() => {});
  const suppressClick = useRef(false);
  const action = useRef(split);
  action.current = split;

  const cancel = () => {
    gesture.current.cancel();
    cleanup.current();
    setPhase('idle');
  };
  useEffect(() => {
    if (!enabled) {
      gesture.current.cancel();
      cleanup.current();
      setPhase('idle');
    }
    return () => {
      gesture.current.cancel();
      cleanup.current();
    };
  }, [enabled]);

  const onPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    cancel();
    suppressClick.current = false;
    if (!event.isPrimary || event.button !== 0) return;
    select();
    if (
      !enabled ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.shiftKey
    )
      return;
    const controller = gesture.current;
    controller.start(
      event.pointerId,
      event.clientX,
      event.clientY,
      performance.now(),
    );
    const hint = setTimeout(() => setPhase('holding'), HOLD_HINT_DELAY_MS);
    const timer = setTimeout(() => setPhase('ready'), LONG_PRESS_MS);
    const move = (next: PointerEvent) => {
      if (!controller.move(next.pointerId, next.clientX, next.clientY))
        cancel();
    };
    const release = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      controller.move(next.pointerId, next.clientX, next.clientY);
      const triggered = controller.release(next.pointerId, performance.now());
      cancel();
      if (triggered) {
        suppressClick.current = true;
        action.current();
      }
    };
    const key = (next: KeyboardEvent) => {
      if (next.key === 'Escape') cancel();
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', release, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', cancel, true);
    window.addEventListener('pointerdown', cancel, true);
    document.addEventListener('visibilitychange', cancel);
    cleanup.current = () => {
      clearTimeout(hint);
      clearTimeout(timer);
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', release, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', cancel, true);
      window.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('visibilitychange', cancel);
    };
  };
  return {
    phase,
    onPointerDown,
    cancel,
    consumeClick: () => {
      const suppressed = suppressClick.current;
      suppressClick.current = false;
      return suppressed;
    },
  };
}
