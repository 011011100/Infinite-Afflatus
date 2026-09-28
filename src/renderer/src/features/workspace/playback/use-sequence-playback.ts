import { useEffect, useRef, useState } from 'react';
import type { Asset } from '../../../../../shared/models';
import { mediaUrl } from '../media';
import { type PlaybackState, SequencePlayback } from './sequence-playback';

export function useSequencePlayback(projectId: string, assets: Asset[]) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const controller = useRef<SequencePlayback | null>(null);
  const [state, setState] = useState<PlaybackState>({
    index: 0,
    pending: 0,
    error: null,
  });
  useEffect(() => {
    if (!first.current || !second.current) return;
    const playback = new SequencePlayback(
      [first.current, second.current],
      assets.map((asset) => mediaUrl(projectId, asset.id)),
      setState,
    );
    controller.current = playback;
    void playback.select(0);
    return () => {
      controller.current = null;
      playback.dispose();
    };
  }, [projectId, assets]);
  return {
    ...state,
    videoRefs: [
      { id: 'first', ref: first },
      { id: 'second', ref: second },
    ],
    select: (index: number) => {
      void controller.current?.select(index);
    },
    stop: () => controller.current?.stop(),
  };
}
