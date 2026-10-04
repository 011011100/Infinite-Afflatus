import { type RefObject, use, useEffect, useRef, useState } from 'react';
import {
  ThumbnailActivityContext,
  ThumbnailContext,
} from './thumbnail-provider';

// A regroup animation lasts 440 ms. Retain its already-painted pixels through
// temporary clipping; selection alone never reserves a decoded frame.
const RELEASE_DELAY = 600;

export function useThumbnailVisibility(target: RefObject<HTMLElement | null>) {
  const resources = use(ThumbnailContext);
  const active = use(ThumbnailActivityContext);
  if (!resources) throw new Error('ThumbnailProvider is missing');
  const [visibility, setVisibility] = useState({ near: false, visible: false });
  const [retained, setRetained] = useState(true);
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  const pointer = useRef<number | null>(null);
  const release = useRef<() => void>(() => {});
  const requested =
    active && (visibility.near || visibility.visible || focused || pressed);
  useEffect(() => {
    const element = target.current;
    if (!element) return;
    return resources.visibility.observe(element, setVisibility);
  }, [resources, target]);
  useEffect(() => {
    if (requested) {
      setRetained(true);
      return;
    }
    const timer = setTimeout(() => setRetained(false), RELEASE_DELAY);
    return () => clearTimeout(timer);
  }, [requested]);
  useEffect(() => () => release.current(), []);
  return {
    requested,
    priority: focused || pressed ? 2 : visibility.visible ? 1 : 0,
    retained: active && (requested || retained),
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    onPointerDown: (event: {
      isPrimary: boolean;
      button: number;
      pointerId: number;
    }) => {
      if (!event.isPrimary || event.button !== 0) return;
      release.current();
      pointer.current = event.pointerId;
      setPressed(true);
      const finish = () => {
        pointer.current = null;
        setPressed(false);
        release.current();
      };
      const up = (event: PointerEvent) => {
        if (event.pointerId === pointer.current) finish();
      };
      const key = (event: KeyboardEvent) => {
        if (event.key === 'Escape') finish();
      };
      window.addEventListener('pointerup', up, true);
      window.addEventListener('pointercancel', up, true);
      window.addEventListener('blur', finish);
      window.addEventListener('keydown', key, true);
      release.current = () => {
        window.removeEventListener('pointerup', up, true);
        window.removeEventListener('pointercancel', up, true);
        window.removeEventListener('blur', finish);
        window.removeEventListener('keydown', key, true);
        release.current = () => {};
      };
    },
  };
}
