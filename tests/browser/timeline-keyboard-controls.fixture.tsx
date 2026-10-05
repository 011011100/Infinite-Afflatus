import { StrictMode, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SequenceTimeline } from '@/features/workspace/editor/sequence-timeline';
import {
  buildTimeline,
  locateTime,
} from '@/features/workspace/editor/timeline';
import { useSequenceEditor } from '@/features/workspace/editor/use-sequence-editor';
import type { VideoMetadata } from '@/features/workspace/video-metadata';
import type { DesktopBridge } from '../../src/shared/desktop';
import { defaultInteractionSettings } from '../../src/shared/interaction/settings';
import type { Asset } from '../../src/shared/models';
import '../../src/renderer/src/styles.css';

const assets: Asset[] = ['前段', '已裁剪第二段', '末段'].map((name, index) => ({
  id: `clip-${index + 1}`,
  name,
  relativePath: `assets/videos/clip-${index + 1}.mp4`,
  kind: 'video',
  size: 1,
  sha256: 'a'.repeat(64),
}));
const frames = new Map<string, VideoMetadata>(
  assets.map((asset) => [asset.id, { duration: 1, width: 160, height: 90 }]),
);
const clips = buildTimeline(
  assets,
  new Map(assets.map((asset) => [asset.id, 1])),
  {
    'clip-1': { start: 0.1, end: 0.5 },
    'clip-2': { start: 0.6, end: 0.9 },
  },
);
const events: { type: 'select' | 'seek'; value: number; final?: boolean }[] =
  [];
let mutations = 0;
const mutated = () => {
  mutations++;
};

function Fixture() {
  const [time, setTime] = useState(1.2);
  const [selected, setSelected] = useState(2);
  const [playing, setPlaying] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [disabled, setDisabled] = useState(false);
  useLayoutEffect(() => {
    Object.assign(window, {
      timelineControls: {
        state: () => ({
          time,
          selected,
          playing,
          zoom,
          disabled,
          events,
          mutations,
          clips,
          sourceTime: locateTime(clips, time).sourceTime,
        }),
        configure: (next: {
          time?: number;
          selected?: number;
          playing?: boolean;
          zoom?: number;
          disabled?: boolean;
        }) => {
          if (next.time !== undefined) setTime(next.time);
          if (next.selected !== undefined) setSelected(next.selected);
          if (next.playing !== undefined) setPlaying(next.playing);
          if (next.zoom !== undefined) setZoom(next.zoom);
          if (next.disabled !== undefined) setDisabled(next.disabled);
        },
      },
    });
  });
  return (
    <main
      className="border bg-background"
      style={{ width: 900, margin: '96px auto', padding: 20 }}
    >
      <p className="mb-8 text-sm">时间轨道键盘回归</p>
      <SequenceTimeline
        projectId="timeline-keyboard-project"
        clips={clips}
        frames={frames}
        time={time}
        playingIndex={locateTime(clips, time).index}
        playing={playing}
        selected={selected}
        disabled={disabled}
        reset={0}
        zoom={zoom}
        onSelect={(index) => {
          events.push({ type: 'select', value: index });
          setSelected(index);
        }}
        onSeek={(next, final) => {
          events.push({
            type: 'seek',
            value: next,
            ...(final === undefined ? {} : { final }),
          });
          setTime(next);
        }}
        onPreview={mutated}
        onCommit={mutated}
        onCancel={mutated}
        onGesture={mutated}
      />
    </main>
  );
}

const card = {
  id: 'sequence',
  position: { x: 0, y: 0 },
  assetIds: assets.map((asset) => asset.id),
  trims: Object.fromEntries(clips.map((clip) => [clip.asset.id, clip.range])),
};
const seeks: number[] = [];
const playbackBridge: Pick<DesktopBridge, 'prepareProxy'> = {
  prepareProxy: async () => ({ ready: false }),
};
Object.assign(window, { desktop: playbackBridge });

/** Include the real window capture handler and playback controller, not only the timeline's own listeners. */
function EditorCaptureFixture() {
  const editor = useSequenceEditor({
    card,
    assets,
    frames,
    projectId: 'timeline-keyboard-project',
    projectName: '编辑页键盘边界',
    blocked: false,
    saving: false,
    shortcuts: defaultInteractionSettings().shortcuts,
    canUndo: false,
    canRedo: false,
    undo: mutated,
    redo: mutated,
    commit: async () => {
      mutated();
      return true;
    },
    onClose: mutated,
  });
  useLayoutEffect(() => {
    Object.assign(window, {
      prepareEditorCapture: () => {
        // The actual editor autoplays on entry. Establish a paused start through
        // its real controller before testing relative keyboard seeking.
        editor.playback.pause();
        editor.seek(0);
      },
      editorCapture: () => ({
        time: editor.time,
        selected: editor.selected,
        playing: editor.playback.playing,
        pending: editor.playback.pending,
        error: editor.playback.error,
        seeks,
        mutations,
      }),
    });
  });
  return (
    <main style={{ width: 900, margin: '64px auto' }}>
      <div style={{ display: 'flex', height: 90 }}>
        {editor.playback.videoRefs.map(({ id, ref }) => (
          <video key={id} ref={ref} muted width={160} height={90} />
        ))}
      </div>
      <SequenceTimeline
        projectId="timeline-keyboard-project"
        clips={editor.clips}
        frames={frames}
        time={editor.time}
        playingIndex={editor.playback.index}
        playing={editor.playback.playing}
        selected={editor.selected}
        disabled={editor.disabled}
        reset={editor.reset}
        zoom={1}
        onSelect={(index) => editor.setSelectedId(assets[index]?.id)}
        onSeek={(next, final) => {
          seeks.push(next);
          editor.seek(next, final);
        }}
        onPreview={editor.preview}
        onCommit={editor.save}
        onCancel={editor.cancel}
        onGesture={editor.setGesturing}
      />
    </main>
  );
}

const root = document.getElementById('root');
if (!root) throw new Error('Missing fixture root');
createRoot(root).render(
  <StrictMode>
    {location.search ? <EditorCaptureFixture /> : <Fixture />}
  </StrictMode>,
);
