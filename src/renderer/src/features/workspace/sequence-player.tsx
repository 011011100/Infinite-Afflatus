import { useCallback, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { Asset } from '../../../../shared/models';
import { mediaUrl } from './media';

export function SequencePlayer({
  assets,
  projectId,
  onClose,
}: {
  assets: Asset[];
  projectId: string;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const preferences = useRef({ volume: 1, muted: false, rate: 1 });
  const attachVideo = useCallback((video: HTMLVideoElement | null) => {
    if (!video) return;
    video.volume = preferences.current.volume;
    video.muted = preferences.current.muted;
    video.playbackRate = preferences.current.rate;
  }, []);
  const asset = assets[index];
  if (!asset) return null;
  const seek = (next: number) => {
    setError(null);
    setIndex(next);
  };
  return (
    <Modal
      title={
        assets.length === 1
          ? asset.name
          : `组合预览 · ${index + 1} / ${assets.length}`
      }
      wide
      onClose={onClose}
      error={error}
    >
      <video
        key={asset.id}
        ref={attachVideo}
        controls
        autoPlay
        playsInline
        src={mediaUrl(projectId, asset.id)}
        onVolumeChange={(event) => {
          preferences.current.volume = event.currentTarget.volume;
          preferences.current.muted = event.currentTarget.muted;
        }}
        onRateChange={(event) => {
          preferences.current.rate = event.currentTarget.playbackRate;
        }}
        onEnded={() => {
          if (index + 1 < assets.length) seek(index + 1);
        }}
        onError={() =>
          setError(
            '这段视频暂时无法播放，请检查文件或编码格式。可以选择其他片段继续预览。',
          )
        }
        className="max-h-[60vh] w-full rounded-lg bg-black"
      >
        <track kind="captions" />
      </video>
      {assets.length > 1 && (
        <fieldset
          className="mt-4 flex gap-2 overflow-x-auto pb-1"
          aria-label="组合播放顺序"
        >
          {assets.map((item, order) => (
            <Button
              key={item.id}
              variant={index === order ? 'secondary' : 'ghost'}
              aria-pressed={index === order}
              onClick={() => seek(order)}
              className="max-w-52 shrink-0"
            >
              <span className="text-xs tabular-nums text-muted-foreground">
                {String(order + 1).padStart(2, '0')}
              </span>
              <span className="truncate">{item.name}</span>
            </Button>
          ))}
        </fieldset>
      )}
      <p className="mt-3 text-xs text-muted-foreground">
        {assets.length > 1
          ? '按从左到右的顺序预览；片段切换可能有短暂间隔。'
          : '按 Esc 关闭预览，返回原画布。'}
      </p>
    </Modal>
  );
}
