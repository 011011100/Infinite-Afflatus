import { useEffect, useRef, useState } from 'react';
import type { TimelineClip } from '../editor/timeline';
import { mediaUrl } from '../media';
import { mediaRevision, useMediaRevision } from '../use-media-revision';
import { AdaptivePlayback } from './adaptive-playback';
import { prepareSequenceProxies } from './prepare-sequence-proxies';
import type { PlaybackState } from './sequence-playback';

export function useSequencePlayback(projectId: string, clips: TimelineClip[]) {
  useMediaRevision(projectId);
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
  const revisions = clips
    .map((clip) => mediaRevision(projectId, clip.asset.id))
    .join(',');
  const muted = useRef(false);
  const retained = useRef<{
    projectId: string;
    sourceKey: string;
    revisions: string;
    state: PlaybackState;
  } | null>(null);
  const [state, setState] = useState<PlaybackState>({
    index: 0,
    pending: 0,
    error: null,
    time: 0,
    playing: false,
    target: null,
  });
  const currentState = useRef(state);
  useEffect(() => {
    const previous = retained.current;
    const resume =
      previous?.projectId === projectId &&
      previous.sourceKey === sourceKey &&
      previous.revisions !== revisions
        ? previous.state
        : null;
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
      sourceKey
        .split(',')
        .map((id) => mediaUrl(projectId, id, mediaRevision(projectId, id))),
      (next) => {
        currentState.current = next;
        setState(next);
      },
    );
    playback.setRanges(latest.current.map((clip) => clip.range));
    controller.current = playback;
    playback.setMuted(muted.current);
    if (resume)
      void playback.select(
        resume.target?.index ?? resume.pending ?? resume.index,
        resume.target?.time ?? resume.time,
        resume.playing,
      );
    else void playback.select(0);
    setProxyStatus('preparing');
    const releaseUsage = prepareSequenceProxies(
      window.desktop,
      projectId,
      sourceKey.split(','),
      (index, url) => playback.setProxy(index, url),
      (ready) => setProxyStatus(ready ? 'ready' : 'unavailable'),
    );
    return () => {
      retained.current = {
        projectId,
        sourceKey,
        revisions,
        state: { ...currentState.current },
      };
      controller.current = null;
      playback.dispose();
      releaseUsage();
    };
  }, [projectId, sourceKey, revisions]);
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
    mute: (value: boolean) => {
      muted.current = value;
      controller.current?.setMuted(value);
    },
    stop: () => controller.current?.stop(),
  };
}
