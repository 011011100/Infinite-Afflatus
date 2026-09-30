import { Pause, Play, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { formatTime } from './timeline';
import { TimelineToolbar } from './timeline-toolbar';

export function SequenceControls({
  time,
  duration,
  index,
  count,
  playing,
  muted,
  gesturing,
  zoom,
  restoreDisabled,
  onTogglePlayback,
  onToggleMute,
  onZoomChange,
  onRestore,
}: {
  time: number;
  duration: number;
  index: number;
  count: number;
  playing: boolean;
  muted: boolean;
  gesturing: boolean;
  zoom: number;
  restoreDisabled: boolean;
  onTogglePlayback: () => void;
  onToggleMute: () => void;
  onZoomChange: (zoom: number) => void;
  onRestore: () => void;
}) {
  return (
    <fieldset
      aria-label="播放与轨道控制"
      className="grid h-16 min-w-0 shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-4 px-8"
    >
      <div className="flex items-center gap-4">
        <Button
          size="icon"
          aria-label={playing ? '暂停' : '播放'}
          disabled={gesturing}
          onClick={onTogglePlayback}
        >
          {playing ? (
            <Pause fill="currentColor" />
          ) : (
            <Play fill="currentColor" />
          )}
        </Button>
        <span
          role="timer"
          className="whitespace-nowrap font-mono text-sm tabular-nums"
          aria-label="组合播放时间"
        >
          {formatTime(time)}{' '}
          <span className="text-muted-foreground">
            / {formatTime(duration)}
          </span>
        </span>
      </div>
      <span
        className="whitespace-nowrap text-xs tabular-nums text-muted-foreground"
        aria-live="off"
      >
        <span className="sr-only">当前片段</span>
        {String(index + 1).padStart(2, '0')} / {count}
      </span>
      <div className="flex items-center gap-3 justify-self-end">
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={muted ? '取消静音' : '静音'}
          onClick={onToggleMute}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>
        <TimelineToolbar
          zoom={zoom}
          zoomDisabled={gesturing}
          onZoomChange={onZoomChange}
          restoreDisabled={restoreDisabled}
          onRestore={onRestore}
        />
      </div>
    </fieldset>
  );
}
