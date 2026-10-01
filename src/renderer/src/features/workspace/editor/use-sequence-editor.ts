import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { isMac } from '@/lib/platform';
import type {
  CanvasCard,
  CanvasPatch,
} from '../../../../../shared/canvas/model';
import type { ClipTrim } from '../../../../../shared/canvas/trim';
import {
  type Shortcuts,
  shortcutAction,
} from '../../../../../shared/interaction/shortcuts';
import type { Asset } from '../../../../../shared/models';
import type { ThumbnailFrame } from '../decode-thumbnail';
import { useSequencePlayback } from '../playback/use-sequence-playback';
import { buildTimeline, locateTime, totalDuration } from './timeline';
import { TrimSaveQueue } from './trim-save-queue';

export interface EditorProps {
  card: CanvasCard;
  assets: Asset[];
  projectId: string;
  projectName: string;
  blocked: boolean;
  saving: boolean;
  shortcuts: Shortcuts;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  commit: (patch: CanvasPatch) => Promise<boolean>;
  onClose: () => void;
}

export function useSequenceEditor(
  props: EditorProps & {
    frames: Map<string, ThumbnailFrame>;
    closing?: boolean;
  },
) {
  const { card, assets, frames, blocked, saving } = props;
  const [draft, setDraft] = useState<{
    assetId: string;
    range: ClipTrim;
  } | null>(null);
  const write = useRef(props.commit);
  write.current = props.commit;
  const [queue] = useState(
    () => new TrimSaveQueue(card, (patch) => write.current(patch)),
  );
  const edits = useSyncExternalStore(queue.subscribe, queue.getSnapshot);
  useEffect(() => {
    queue.accept(card);
  }, [queue, card]);
  const resetSeen = useRef(0);
  useEffect(() => {
    if (edits.reset !== resetSeen.current) {
      resetSeen.current = edits.reset;
      setDraft(null);
      queue.accept(card);
    }
  }, [edits.reset, queue, card]);
  const [selectedId, setSelectedId] = useState(assets[0]?.id);
  const [gesturing, setGesturing] = useState(false);
  const [muted, setMuted] = useState(false);
  const durations = useMemo(
    () => new Map([...frames].map(([id, frame]) => [id, frame.duration ?? 0])),
    [frames],
  );
  const clips = useMemo(
    () =>
      buildTimeline(
        assets,
        durations,
        draft
          ? { ...edits.card.trims, [draft.assetId]: draft.range }
          : edits.card.trims,
      ),
    [assets, durations, draft, edits.card.trims],
  );
  const playback = useSequencePlayback(props.projectId, clips);
  const stop = playback.stop;
  useEffect(() => {
    // Metadata may finish loading during the exit; a late-mounted player must stay stopped.
    if (props.closing) stop();
  }, [props.closing, stop]);
  const selected = Math.max(
    0,
    clips.findIndex((clip) => clip.asset.id === selectedId),
  );
  const active = clips[playback.index];
  const editing = clips[selected];
  const total = totalDuration(clips);
  const cursor = clips[playback.target?.index ?? playback.index];
  const time = cursor
    ? cursor.offset +
      Math.max(
        0,
        Math.min(
          cursor.length,
          (playback.target?.time ?? playback.time) - cursor.range.start,
        ),
      )
    : 0;
  const pending = saving || edits.pending;
  const disabled = blocked || pending;
  const close = () => {
    if (pending || gesturing || props.closing) return;
    playback.stop();
    props.onClose();
  };
  const cancel = () => {
    setDraft(null);
    playback.pause();
  };
  const seek = (value: number, final = true) => {
    const target = locateTime(clips, value);
    playback.seek(target.index, target.sourceTime, final);
  };
  const preview = (index: number, range: ClipTrim, edge: 'start' | 'end') => {
    const clip = clips[index];
    if (!clip) return;
    setDraft({ assetId: clip.asset.id, range });
    // Show the last retained frame, not a frame just outside the outgoing edge.
    playback.seek(
      index,
      edge === 'start' ? range.start : Math.max(range.start, range.end - 0.035),
    );
  };
  const save = (index: number, range: ClipTrim) => {
    if (blocked) {
      cancel();
      return;
    }
    const clip = clips[index];
    if (!clip) return;
    const original = edits.card.trims?.[clip.asset.id] ?? {
      start: 0,
      end: clip.duration,
    };
    if (original.start !== range.start || original.end !== range.end)
      queue.enqueue(clip.asset.id, range);
    setDraft(null);
  };

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (
        props.closing ||
        event.defaultPrevented ||
        event.repeat ||
        event.isComposing
      )
        return;
      if (event.key === 'Escape') {
        if (gesturing) return;
        event.preventDefault();
        close();
        return;
      }
      if (
        event.target instanceof Element &&
        event.target.closest('input,textarea,select,[contenteditable="true"]')
      )
        return;
      const action = shortcutAction(event, props.shortcuts, isMac);
      if (!action || action === 'split' || action === 'locateLabels') return;
      if (
        event.key === ' ' &&
        event.target instanceof Element &&
        event.target.closest('button') &&
        !event.target.closest('[role="slider"]')
      )
        return;
      event.preventDefault();
      if (action === 'play' && !gesturing) playback.toggle();
      if (!disabled && !gesturing) {
        if (action === 'undo' && props.canUndo) {
          playback.pause();
          props.undo();
        }
        if (action === 'redo' && props.canRedo) {
          playback.pause();
          props.redo();
        }
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  });
  return {
    clips,
    playback,
    selected,
    active,
    editing,
    total,
    time,
    disabled,
    gesturing,
    setGesturing,
    saveError: edits.error,
    pending,
    reset: edits.reset,
    muted,
    setMuted,
    setSelectedId,
    close,
    cancel,
    seek,
    preview,
    save,
  };
}
