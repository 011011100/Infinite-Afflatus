import { useEffect } from 'react';

let keyboardInput = false;

/** High-frequency keyboard actions stay instant; pointer actions can use motion. */
export function instantMotion(): boolean {
  return (
    keyboardInput ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export function useInputMethod(): void {
  useEffect(() => {
    const pointer = () => {
      keyboardInput = false;
    };
    const key = () => {
      keyboardInput = true;
    };
    window.addEventListener('pointerdown', pointer, true);
    window.addEventListener('keydown', key, true);
    return () => {
      window.removeEventListener('pointerdown', pointer, true);
      window.removeEventListener('keydown', key, true);
    };
  }, []);
}
