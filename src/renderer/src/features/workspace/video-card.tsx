import type { Node, NodeProps } from '@xyflow/react';
import { Play, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { SnapTarget } from '../../../../shared/canvas/operations';
import type { ClipTrim } from '../../../../shared/canvas/trim';
import type { Asset } from '../../../../shared/models';
import { VideoThumbnail } from './video-thumbnail';

export type VideoCardNode = Node<
  {
    assets: Asset[];
    projectId: string;
    width: number;
    trims: Record<string, ClipTrim> | undefined;
    activeAssetId: string | null;
    snapSide: SnapTarget['side'] | null;
    play: (id: string) => void;
    openMaterials: (assetId: string) => void;
    canOpenMaterials: boolean;
    canHold: boolean;
    splitAsset: (cardId: string, assetId: string) => void;
    selectAsset: (cardId: string, assetId: string) => void;
  },
  'video'
>;

export function VideoCard({
  id,
  data,
  selected,
  dragging,
}: NodeProps<VideoCardNode>) {
  const grouped = data.assets.length > 1;
  return (
    <article
      data-video-card={id}
      data-card-assets={data.assets.map((asset) => asset.id).join(',')}
      style={{ width: data.width }}
      className={cn(
        'relative rounded-lg bg-background shadow-sm ring-1 ring-border',
        selected && 'ring-2 ring-primary/60',
        dragging && 'shadow-lg',
      )}
    >
      <div
        data-thumbnail-row
        className="nowheel nopan flex divide-x divide-white/15 overflow-x-auto rounded-t-[7px]"
        style={{ scrollbarWidth: 'thin', height: 162 }}
      >
        {data.assets.map((asset, index) => (
          <VideoThumbnail
            key={asset.id}
            asset={asset}
            trim={data.trims?.[asset.id]}
            projectId={data.projectId}
            index={index}
            active={selected === true && data.activeAssetId === asset.id}
            grouped={grouped}
            canHold={data.canHold && !dragging}
            split={() => data.splitAsset(id, asset.id)}
            select={() => data.selectAsset(id, asset.id)}
          />
        ))}
      </div>
      <footer className="flex h-10 items-center gap-3 px-3">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {grouped ? `组合 · ${data.assets.length} 段` : data.assets[0]?.name}
        </span>
        {(!grouped || data.activeAssetId) && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="nodrag nopan shrink-0"
            aria-label="编辑镜头素材"
            title="镜头素材画布"
            disabled={!data.canOpenMaterials}
            onClick={(event) => {
              event.stopPropagation();
              const assetId = data.activeAssetId ?? data.assets[0]?.id;
              if (assetId) data.openMaterials(assetId);
            }}
          >
            <Sparkles />
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="nodrag nopan shrink-0"
          aria-label={
            grouped
              ? `播放组合，共 ${data.assets.length} 段`
              : `播放 ${data.assets[0]?.name}`
          }
          onClick={(event) => {
            event.stopPropagation();
            data.play(id);
          }}
        >
          <Play size={14} fill="currentColor" />
          播放
        </Button>
      </footer>
      {data.snapSide && (
        <div
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute -top-1 -bottom-1 w-1 rounded-full bg-primary',
            data.snapSide === 'left' ? '-left-2' : '-right-2',
          )}
        />
      )}
    </article>
  );
}
