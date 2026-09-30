import { useEffect, useRef, useState } from 'react';
import type { TimelineClip } from '../editor/timeline';
import { mediaUrl } from '../media';
import { AdaptivePlayback } from './adaptive-playback';
import type { PlaybackState } from './sequence-playback';

export function useSequencePlayback(projectId: string, clips: TimelineClip[]) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const proxyFirst = useRef<HTMLVideoElement>(null);
  const proxySecond = useRef<HTMLVideoElement>(null);
  const controller = useRef<AdaptivePlayback | null>(null);
  const [proxyStatus, setProxyStatus] = useState<
    'preparing' | 'ready' | 'unavailable'
  >('preparing');
  const latest = useRef(clips);
  latest.current = clips;
  const sourceKey = clips.map((clip) => clip.asset.id).join(',');
  const [state, setState] = useState<PlaybackState>({
    index: 0,
    pending: 0,
    error: null,
    time: 0,
    playing: false,
    target: null,
  });
  useEffect(() => {
    if (
      !first.current ||
      !second.current ||
      !proxyFirst.current ||
      !proxySecond.current
    )
      return;
    const playback = new AdaptivePlayback(
      [first.current, second.current],
      [proxyFirst.current, proxySecond.current],
      sourceKey.split(',').map((id) => mediaUrl(projectId, id)),
      setState,
    );
    playback.setRanges(latest.current.map((clip) => clip.range));
    controller.current = playback;
    void playback.select(0);
    let disposed = false;
    setProxyStatus('preparing');
    void Promise.all(
      sourceKey.split(',').map(async (id, index) => {
        try {
          const result = await window.desktop.prepareProxy(projectId, id);
          if (result.ready && !disposed)
            playback.setProxy(
              index,
              `afflatus-media://proxy/${projectId}/${id}`,
            );
          return result.ready;
        } catch {
          return false;
        }
      }),
    ).then((results) => {
      if (!disposed)
        setProxyStatus(results.every(Boolean) ? 'ready' : 'unavailable');
    });
    return () => {
      disposed = true;
      controller.current = null;
      playback.dispose();
    };
  }, [projectId, sourceKey]);
  useEffect(() => {
    controller.current?.setRanges(clips.map((clip) => clip.range));
  }, [clips]);
  return {
    ...state,
    proxyStatus,
    videoRefs: [
      { id: 'first', ref: first },
      { id: 'second', ref: second },
      { id: 'proxy-first', ref: proxyFirst },
      { id: 'proxy-second', ref: proxySecond },
    ],
    select: (index: number, time?: number, autoplay = false) => {
      void controller.current?.select(index, time, autoplay);
    },
    seek: (index: number, time: number, final = false) =>
      controller.current?.seek(index, time, final),
    toggle: () => controller.current?.toggle(),
    pause: () => controller.current?.pause(),
    mute: (value: boolean) => controller.current?.setMuted(value),
    stop: () => controller.current?.stop(),
  };
}
