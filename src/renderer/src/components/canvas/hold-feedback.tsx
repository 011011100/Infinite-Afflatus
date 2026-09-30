import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { createPortal } from 'react-dom';
import { HoldSplitIndicator } from './hold-split-indicator';

interface Feedback {
  ready: () => void;
  hide: () => void;
}
interface Indicator {
  id: number;
  x: number;
  y: number;
  zoom: number;
  open: boolean;
  ready: boolean;
}
const FeedbackContext = createContext<
  ((target: HTMLElement) => Feedback) | null
>(null);

/** The exit survives a split removing or reparenting the pressed thumbnail. */
export function HoldFeedbackProvider({ children }: { children: ReactNode }) {
  const [indicator, setIndicator] = useState<Indicator | null>(null);
  const sequence = useRef(0);
  const motion = useRef<HTMLSpanElement>(null);
  const id = indicator?.id;
  const open = indicator?.open;
  useEffect(() => {
    if (id === undefined || open) return;
    // Also cleans up a hold cancelled before its first painted frame and
    // transitions cancelled by an OS reduced-motion preference change.
    const animations = motion.current?.getAnimations() ?? [];
    void Promise.allSettled(
      animations.map((animation) => animation.finished),
    ).then(() =>
      setIndicator((current) =>
        current?.id === id && !current.open ? null : current,
      ),
    );
  }, [id, open]);
  const show = useMemo(
    () =>
      (target: HTMLElement): Feedback => {
        const rect = target.getBoundingClientRect();
        const id = ++sequence.current;
        setIndicator({
          id,
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
          zoom: rect.width / target.offsetWidth,
          open: true,
          ready: false,
        });
        return {
          ready: () =>
            setIndicator((current) =>
              current?.id === id ? { ...current, ready: true } : current,
            ),
          hide: () =>
            setIndicator((current) => {
              if (current?.id !== id) return current;
              return window.matchMedia('(prefers-reduced-motion: reduce)')
                .matches
                ? null
                : { ...current, open: false };
            }),
        };
      },
    [],
  );
  return (
    <FeedbackContext value={show}>
      {children}
      {indicator &&
        createPortal(
          <span
            key={indicator.id}
            className="pointer-events-none fixed z-[70] block size-16"
            style={{
              left: indicator.x,
              top: indicator.y,
              transform: `translate(-50%, -50%) scale(${indicator.zoom})`,
            }}
          >
            <span
              ref={motion}
              className="hold-feedback relative block size-full"
              data-open={indicator.open}
            >
              <HoldSplitIndicator ready={indicator.ready} />
            </span>
          </span>,
          document.body,
        )}
    </FeedbackContext>
  );
}

export function useHoldFeedback() {
  const show = use(FeedbackContext);
  if (!show) throw new Error('HoldFeedbackProvider is missing');
  return show;
}
