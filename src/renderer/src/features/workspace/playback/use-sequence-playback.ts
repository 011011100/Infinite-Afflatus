import { useEffect, useRef, useState } from 'react';
import type { TimelineClip } from '../editor/timeline';
import { mediaUrl } from '../media';
import { type PlaybackState, SequencePlayback } from './sequence-playback';

export function useSequencePlayback(projectId: string, clips: TimelineClip[]) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const controller = useRef<SequencePlayback | null>(null);
  const latest = useRef(clips);
  latest.current = clips;
  const sourceKey = clips.map((clip) => clip.asset.id).join(',');
  const [state, setState] = useState<PlaybackState>({
    index: 0,
    pending: 0,
    error: null,
    time: 0,
    playing: false,
  });
  useEffect(() => {
    if (!first.current || !second.current) return;
    const playback = new SequencePlayback(
      [first.current, second.current],
      sourceKey.split(',').map((id) => mediaUrl(projectId, id)),
      setState,
    );
    playback.setRanges(latest.current.map((clip) => clip.range));
    controller.current = playback;
    void playback.select(0);
    return () => {
      controller.current = null;
      playback.dispose();
    };
  }, [projectId, sourceKey]);
  useEffect(() => {
    controller.current?.setRanges(clips.map((clip) => clip.range));
  }, [clips]);
  return {
    ...state,
    videoRefs: [
      { id: 'first', ref: first },
      { id: 'second', ref: second },
    ],
    select: (index: number, time?: number, autoplay = false) => {
      void controller.current?.select(index, time, autoplay);
    },
    toggle: () => controller.current?.toggle(),
    pause: () => controller.current?.pause(),
    mute: (value: boolean) => controller.current?.setMuted(value),
    stop: () => controller.current?.stop(),
  };
}
