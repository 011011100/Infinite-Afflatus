import type { Node, NodeProps } from '@xyflow/react';
import { Play } from 'lucide-react';
import type { Asset } from '../../../../shared/models';

export type VideoCardNode = Node<
  { asset: Asset; projectId: string; play: (asset: Asset) => void },
  'video'
>;
export function mediaUrl(projectId: string, assetId: string): string {
  return `afflatus-media://asset/${projectId}/${assetId}`;
}
export function VideoCard({ data }: NodeProps<VideoCardNode>) {
  return (
    <article className="w-72 overflow-hidden rounded-lg border bg-background shadow-sm">
      <div className="relative aspect-video bg-slate-900">
        <video
          muted
          preload="metadata"
          src={mediaUrl(data.projectId, data.asset.id)}
          className="pointer-events-none h-full w-full object-cover"
          aria-label={`${data.asset.name} 缩略预览`}
        />
        <button
          type="button"
          aria-label={`播放 ${data.asset.name}`}
          onClick={() => data.play(data.asset)}
          className="nodrag nopan absolute bottom-3 left-3 flex size-9 items-center justify-center rounded-full bg-black/60 text-white hover:bg-black/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
        >
          <Play size={16} fill="currentColor" />
        </button>
      </div>
      <p className="truncate px-3 py-2.5 text-xs">{data.asset.name}</p>
    </article>
  );
}
