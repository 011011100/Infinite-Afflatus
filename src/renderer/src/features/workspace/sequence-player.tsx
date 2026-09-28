import { LoaderCircle, Maximize } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Modal } from '@/components/ui/modal';
import type { Asset } from '../../../../shared/models';
import { useSequencePlayback } from './playback/use-sequence-playback';

export function SequencePlayer({
  assets,
  projectId,
  onClose,
}: {
  assets: Asset[];
  projectId: string;
  onClose: () => void;
}) {
  const { index, pending, error, videoRefs, select, stop } =
    useSequencePlayback(projectId, assets);
  const surface = useRef<HTMLDivElement>(null);
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const asset = assets[index];
  if (!asset) return null;
  return (
    <Modal
      title={
        assets.length === 1
          ? asset.name
          : `组合预览 · ${index + 1} / ${assets.length}`
      }
      wide
      onClose={onClose}
      onCloseStart={stop}
      error={error || fullscreenError}
    >
      <div
        ref={surface}
        className="group relative isolate aspect-video max-h-[60vh] w-full overflow-hidden rounded-lg bg-black fullscreen:max-h-none"
        aria-busy={pending !== null}
      >
        {videoRefs.map(({ ref, id }) => (
          <video
            key={id}
            ref={ref}
            playsInline
            controlsList="nofullscreen"
            disablePictureInPicture
            className="absolute inset-0 size-full bg-black object-contain"
          >
            <track kind="captions" />
          </video>
        ))}
        {pending !== null && (
          <div
            role="status"
            className="pointer-events-none absolute right-3 top-3 z-10 rounded-full bg-black/50 p-2 text-white"
          >
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
            <span className="sr-only">正在准备视频</span>
          </div>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="切换全屏"
          className="absolute left-3 top-3 z-10 bg-black/50 text-white opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => {
            setFullscreenError(null);
            const operation = document.fullscreenElement
              ? document.exitFullscreen()
              : surface.current?.requestFullscreen();
            void operation?.catch(() => {
              setFullscreenError(
                '当前窗口暂时无法进入全屏，可以继续在浮层内预览。',
              );
            });
          }}
        >
          <Maximize />
        </Button>
      </div>
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
              onClick={() => select(order)}
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
    </Modal>
  );
}
