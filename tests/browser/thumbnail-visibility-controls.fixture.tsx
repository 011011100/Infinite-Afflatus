import { StrictMode, useEffect, useLayoutEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { HoldFeedbackProvider } from '@/components/canvas/hold-feedback';
import { decodeThumbnail } from '@/features/workspace/decode-thumbnail';
import { useSequenceFrames } from '@/features/workspace/editor/use-sequence-frames';
import {
  ThumbnailActivityContext,
  ThumbnailContext,
} from '@/features/workspace/thumbnail-provider';
import { ThumbnailResources } from '@/features/workspace/thumbnail-resources';
import { refreshRestoredMedia } from '@/features/workspace/use-media-revision';
import { readVideoMetadata } from '@/features/workspace/video-metadata';
import { VideoThumbnail } from '@/features/workspace/video-thumbnail';
import type { Asset } from '../../src/shared/models';
import '../../src/renderer/src/styles.css';

const assets: Asset[] = Array.from({ length: 40 }, (_, index) => ({
  id: `asset-${index}`,
  name: `片段 ${index + 1}`,
  kind: 'video',
  relativePath: `video-${index}.mp4`,
  size: 1630,
  sha256: String(index),
}));
const source = new URL('./sample.mp4', location.href).href;
let frameDecodes = 0;
let metadataReads = 0;
let active = 0;
let peak = 0;
let splits = 0;
let pointerDown: string | null = null;
document.addEventListener(
  'pointerdown',
  (event) => {
    pointerDown =
      (event.target as HTMLElement)
        .closest('[data-asset-id]')
        ?.getAttribute('data-asset-id') ?? null;
  },
  true,
);
let firstPaint: number[] = [];
let metadataResult: unknown[] | null = null;
let metadataError: string | null = null;
let delay = false;
const delayed: { source: string; signal: AbortSignal; release(): void }[] = [];
const frameSources: string[] = [];
const track = async <T,>(operation: () => Promise<T>) => {
  active++;
  peak = Math.max(peak, active);
  try {
    return await operation();
  } finally {
    active--;
  }
};
const resources = new ThumbnailResources(
  (url, signal) =>
    track(async () => {
      frameDecodes++;
      frameSources.push(url);
      if (delay)
        await new Promise<void>((resolve) =>
          delayed.push({ source: url, signal, release: resolve }),
        );
      // A deliberately non-cooperative late decoder exercises stale-result rejection.
      return decodeThumbnail(
        source,
        delay ? new AbortController().signal : signal,
      );
    }),
  (_url, signal) =>
    track(async () => {
      metadataReads++;
      return readVideoMetadata(source, signal);
    }),
);

function Metadata() {
  const { frames, error } = useSequenceFrames('fixture', assets);
  metadataResult = frames ? [...frames.values()] : null;
  metadataError = error;
  return (
    <output id="metadata-state">{error ?? frames?.size ?? 'loading'}</output>
  );
}
function Clips({ generation, twin }: { generation: number; twin: number }) {
  useLayoutEffect(() => {
    void generation;
    firstPaint = [
      ...document.querySelectorAll<HTMLCanvasElement>('#clips canvas'),
    ].map((canvas) => canvas.width);
  }, [generation]);
  return (
    <div
      id="clips"
      className="flex w-[432px] overflow-x-auto"
      style={{ height: 180, width: 432 }}
    >
      {(twin
        ? [
            { key: 'left', asset: assets[0] },
            ...(twin === 2 ? [{ key: 'right', asset: assets[0] }] : []),
          ]
        : assets.map((asset) => ({ key: asset.id, asset }))
      ).map(
        ({ key, asset }, index) =>
          asset && (
            <VideoThumbnail
              key={key}
              asset={asset}
              trim={undefined}
              projectId="fixture"
              index={index}
              active
              grouped
              canHold
              select={() => {}}
              split={() => {
                splits++;
              }}
            />
          ),
      )}
    </div>
  );
}
function Fixture() {
  const [mounted, setMounted] = useState(true);
  const [covered, setCovered] = useState(false);
  const [generation, setGeneration] = useState(0);
  const [editor, setEditor] = useState(false);
  const [twin, setTwin] = useState(0);
  useEffect(() => () => resources.clear(), []);
  Object.assign(window, {
    thumbnailControls: {
      cover: setCovered,
      mount: setMounted,
      editor: setEditor,
      twin: setTwin,
      regroup: () => setGeneration((value) => value + 1),
      delay: (value: boolean) => {
        delay = value;
      },
      release: () => {
        for (const item of delayed.splice(0)) item.release();
      },
      repair: (id: string) => refreshRestoredMedia('fixture', id),
      reset: () => {
        frameDecodes = 0;
        metadataReads = 0;
        peak = active;
        firstPaint = [];
      },
      clear: () => resources.clear(),
      stats: () => ({
        frameDecodes,
        metadataReads,
        peak,
        active,
        splits,
        pointerDown,
        firstPaint,
        metadataResult,
        metadataError,
        frameSources,
        delayed: delayed.map((item) => ({
          source: item.source,
          aborted: item.signal.aborted,
        })),
        cache: resources.cache.stats(),
        metadata: resources.metadata.stats(),
        dimensions: [
          ...document.querySelectorAll<HTMLCanvasElement>('#clips canvas'),
        ].map((canvas) => [canvas.width, canvas.height]),
        buttons: document.querySelectorAll('[data-video-thumbnail]').length,
      }),
    },
  });
  return (
    <ThumbnailContext value={resources}>
      <HoldFeedbackProvider>
        <main className="p-8">
          <h1>实际裁切与缩略图资源回归</h1>
          <button type="button" id="blur">
            移开焦点
          </button>
          <ThumbnailActivityContext value={!covered}>
            {mounted && (
              <Clips key={generation} generation={generation} twin={twin} />
            )}
          </ThumbnailActivityContext>
          {editor && <Metadata />}
        </main>
      </HoldFeedbackProvider>
    </ThumbnailContext>
  );
}
const element = document.getElementById('root');
if (!element) throw new Error('fixture root missing');
createRoot(element).render(
  <StrictMode>
    <Fixture />
  </StrictMode>,
);
