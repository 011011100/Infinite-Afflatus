import { Group } from 'lucide-react';
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
import { HoldProgress } from '@/components/ui/hold-progress';
import { LONG_PRESS_MS } from '../../../../shared/interaction/long-press';
import { HoldSplitIndicator } from './hold-split-indicator';

interface Feedback {
  ready: () => void;
  hide: () => void;
  move: (anchor: FeedbackAnchor) => void;
}
interface FeedbackAnchor {
  x: number;
  y: number;
  zoom: number;
}
interface Indicator {
  id: number;
  x: number;
  y: number;
  zoom: number;
  open: boolean;
  ready: boolean;
  action: 'split' | 'join';
}
const FeedbackContext = createContext<
  | ((
      target: HTMLElement | FeedbackAnchor,
      action?: 'split' | 'join',
    ) => Feedback)
  | null
>(null);

/** Feedback survives a split or join reparenting the card beneath it. */
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
      (
        target: HTMLElement | FeedbackAnchor,
        action: 'split' | 'join' = 'split',
      ): Feedback => {
        let anchor: FeedbackAnchor;
        if (target instanceof HTMLElement) {
          const rect = target.getBoundingClientRect();
          anchor = {
            x: rect.left + rect.width / 2,
            y: rect.top + rect.height / 2,
            zoom: rect.width / target.offsetWidth,
          };
        } else anchor = target;
        const id = ++sequence.current;
        setIndicator({
          id,
          ...anchor,
          open: true,
          ready: false,
          action,
        });
        return {
          move: (anchor) =>
            setIndicator((current) =>
              current?.id === id &&
              (current.x !== anchor.x ||
                current.y !== anchor.y ||
                current.zoom !== anchor.zoom)
                ? { ...current, ...anchor }
                : current,
            ),
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
              {indicator.action === 'join' ? (
                <HoldProgress
                  ready={indicator.ready}
                  duration={LONG_PRESS_MS}
                  icon={<Group size={20} />}
                  label={indicator.ready ? '已加入生成组' : '悬停加入生成组'}
                />
              ) : (
                <HoldSplitIndicator ready={indicator.ready} />
              )}
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
