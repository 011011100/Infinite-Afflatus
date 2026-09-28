import {
  ArrowLeft,
  LoaderCircle,
  Pause,
  Play,
  Redo2,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import type { ThumbnailFrame } from '../decode-thumbnail';
import { SequenceTimeline } from './sequence-timeline';
import { formatTime } from './timeline';
import { type EditorProps, useSequenceEditor } from './use-sequence-editor';
import { useSequenceFrames } from './use-sequence-frames';

export function SequenceEditor(props: EditorProps) {
  const { frames, error, retry } = useSequenceFrames(
    props.projectId,
    props.assets,
  );
  const page = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = document.getElementById('root');
    const focus = document.activeElement;
    if (root) root.inert = true;
    page.current?.focus();
    return () => {
      if (root) root.inert = false;
      if (focus instanceof HTMLElement && focus.isConnected) focus.focus();
    };
  }, []);
  return createPortal(
    <section
      ref={page}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex min-h-0 flex-col bg-background outline-none"
      aria-label="视频播放与编辑"
      onKeyDown={(event) => {
        if (!frames && event.key === 'Escape') {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      {frames ? (
        <EditorContent {...props} frames={frames} />
      ) : (
        <>
          <header className="flex h-14 shrink-0 items-center border-b px-5">
            <Button variant="ghost" onClick={props.onClose}>
              <ArrowLeft />
              返回画布
            </Button>
          </header>
          <div className="flex flex-1 items-center justify-center gap-3 text-sm text-muted-foreground">
            {error ? (
              <>
                <span role="alert">{error}</span>
                <Button variant="outline" onClick={retry}>
                  重试
                </Button>
              </>
            ) : (
              <>
                <LoaderCircle className="size-5 animate-spin" />
                正在读取视频
              </>
            )}
          </div>
        </>
      )}
    </section>,
    document.body,
  );
}

function EditorContent(
  props: EditorProps & { frames: Map<string, ThumbnailFrame> },
) {
  const { assets, frames, blocked } = props;
  const {
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
    saveError,
    pending,
    reset,
    muted,
    setMuted,
    setSelectedId,
    close,
    cancel,
    seek,
    preview,
    save,
  } = useSequenceEditor(props);
  if (!active || !editing) return null;
  return (
    <>
      <header className="flex h-14 shrink-0 items-center gap-4 border-b border-border px-5">
        <Button
          variant="ghost"
          size="sm"
          onClick={close}
          disabled={pending || gesturing}
          aria-label="返回画布"
        >
          <ArrowLeft />
          返回画布
        </Button>
        <span className="h-4 w-px bg-border" />
        <span className="min-w-0 truncate text-sm font-medium">
          {props.projectName}
        </span>
        <span className="text-xs text-muted-foreground">
          {assets.length > 1 ? '组合编辑' : '视频编辑'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <span role="status" className="mr-3 text-xs text-muted-foreground">
            {blocked
              ? '迁移中，暂不可编辑'
              : pending
                ? '正在保存…'
                : gesturing
                  ? '裁剪中'
                  : saveError
                    ? '未保存'
                    : '已保存'}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="撤销"
            disabled={disabled || gesturing || !props.canUndo}
            onClick={() => {
              playback.pause();
              props.undo();
            }}
          >
            <Undo2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="重做"
            disabled={disabled || gesturing || !props.canRedo}
            onClick={() => {
              playback.pause();
              props.redo();
            }}
          >
            <Redo2 />
          </Button>
        </div>
      </header>
      {(saveError || playback.error) && (
        <div
          role="alert"
          className="flex items-center justify-between bg-destructive/10 px-8 py-2 text-xs text-destructive"
        >
          <span>{saveError || playback.error}</span>
          {playback.error && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                playback.select(playback.index, active.range.start, true)
              }
            >
              重试播放
            </Button>
          )}
        </div>
      )}
      <section
        className="relative min-h-24 flex-1 bg-slate-950"
        aria-label="视频画面"
        aria-busy={playback.pending !== null}
      >
        {playback.videoRefs.map(({ ref, id }) => (
          <video
            key={id}
            ref={ref}
            playsInline
            disablePictureInPicture
            className="absolute inset-0 size-full object-contain"
          >
            <track kind="captions" />
          </video>
        ))}
        {playback.pending !== null && (
          <div
            role="status"
            className="pointer-events-none absolute right-5 top-5 rounded-full bg-black/40 p-2 text-white"
          >
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
            <span className="sr-only">正在准备视频</span>
          </div>
        )}
      </section>
      <div className="flex h-16 shrink-0 items-center gap-4 px-8">
        <Button
          size="icon"
          aria-label={playback.playing ? '暂停' : '播放'}
          disabled={gesturing}
          onClick={playback.toggle}
        >
          {playback.playing ? (
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
          <span className="text-muted-foreground">/ {formatTime(total)}</span>
        </span>
        <span
          className="mx-auto min-w-0 truncate text-xs text-muted-foreground"
          aria-live="off"
        >
          {String(playback.index + 1).padStart(2, '0')} / {clips.length}{' '}
          <span className="ml-2 text-foreground">{active.asset.name}</span>
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={muted ? '取消静音' : '静音'}
          onClick={() => {
            playback.mute(!muted);
            setMuted(!muted);
          }}
        >
          {muted ? <VolumeX /> : <Volume2 />}
        </Button>
      </div>
      <div className="flex h-11 shrink-0 items-center gap-3 border-t border-border px-8 text-xs">
        <span className="min-w-0 truncate font-medium">
          {String(selected + 1).padStart(2, '0')} · {editing.asset.name}
        </span>
        <span className="whitespace-nowrap tabular-nums text-muted-foreground">
          {formatTime(editing.range.start)} — {formatTime(editing.range.end)}
        </span>
        <span className="ml-auto whitespace-nowrap text-muted-foreground">
          保留 {formatTime(editing.length)}
        </span>
        <Button
          variant="ghost"
          size="sm"
          disabled={
            disabled ||
            gesturing ||
            (editing.range.start === 0 &&
              editing.range.end === editing.duration)
          }
          onClick={() => {
            playback.pause();
            void save(selected, { start: 0, end: editing.duration });
          }}
        >
          恢复原片
        </Button>
      </div>
      <SequenceTimeline
        clips={clips}
        frames={frames}
        time={time}
        playingIndex={playback.index}
        selected={selected}
        disabled={blocked}
        reset={reset}
        onSelect={(index) => setSelectedId(clips[index]?.asset.id)}
        onSeek={seek}
        onPreview={preview}
        onCommit={(index, range) => {
          void save(index, range);
        }}
        onCancel={cancel}
        onGesture={(active) => {
          setGesturing(active);
          if (active) playback.pause();
        }}
      />
    </>
  );
}
