import { FileText, Film, ImageIcon, Music2, X } from 'lucide-react';
import { type ReactNode, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EditableName } from '@/components/ui/editable-name';
import { Modal } from '@/components/ui/modal';
import { cn } from '@/lib/utils';
import type { Asset } from '../../../../shared/models';
import { mediaUrl } from '../workspace/media';
import { useMediaRevision } from '../workspace/use-media-revision';
import { message } from './errors';

export const referenceLabels = {
  image: '图片',
  video: '视频',
  audio: '音频',
  text: '文本',
};
export const referenceIcons = {
  image: ImageIcon,
  video: Film,
  audio: Music2,
  text: FileText,
};

export function ReferenceCard({
  projectId,
  asset,
  label,
  onRemove,
  disabled = false,
  textOverride,
  removeLabel = '从素材画布移除',
  removeIcon,
  name,
  onRename,
  flexible = false,
}: {
  projectId: string;
  asset: Asset;
  label: string;
  onRemove: () => void;
  disabled?: boolean;
  textOverride?: string | undefined;
  removeLabel?: string;
  removeIcon?: ReactNode;
  name?: string | undefined;
  onRename?: (name: string) => void;
  flexible?: boolean;
}) {
  const displayName = name ?? asset.name;
  const Icon = referenceIcons[asset.kind];
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const revision = useMediaRevision(projectId, asset.id);
  const url = mediaUrl(projectId, asset.id, revision);
  useEffect(() => {
    void revision;
    setError(null);
    if (asset.kind !== 'text') return;
    let active = true;
    void window.desktop
      .readReferenceText(projectId, asset.id)
      .then((value) => {
        if (active) setText(value);
      })
      .catch((reason: unknown) => {
        if (active) setError(message(reason));
      });
    return () => {
      active = false;
    };
  }, [projectId, asset.id, asset.kind, revision]);

  return (
    <article
      className={cn(
        'generation-reference group h-full rounded-xl bg-card',
        flexible && 'flex min-h-0 flex-col',
      )}
    >
      <div className="material-handle flex min-w-0 shrink-0 items-center gap-2 px-3 py-2.5 text-xs">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        {onRename ? (
          <EditableName
            value={name ?? label}
            onChange={onRename}
            disabled={disabled}
            className="font-medium"
          />
        ) : (
          <span
            className="min-w-0 flex-1 truncate font-medium"
            title={name ?? label}
          >
            {name ?? label}
          </span>
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={disabled}
          className="nodrag nopan ml-auto shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
          aria-label={
            removeLabel === '从素材画布移除' ? `移除${label}` : removeLabel
          }
          title={removeLabel}
          onClick={onRemove}
        >
          {removeIcon ?? <X />}
        </Button>
      </div>
      <div
        className={cn(
          'nodrag nopan nowheel mx-2 overflow-hidden rounded-lg bg-secondary',
          flexible ? 'min-h-0 flex-1' : 'h-[156px]',
        )}
      >
        {asset.kind === 'image' && (
          <img
            src={url}
            alt={asset.name}
            loading="lazy"
            className="h-full w-full object-contain"
            onError={() => setError('图片无法预览，请检查文件')}
          />
        )}
        {/* User-provided reference media has no app-authored caption track. */}
        {asset.kind === 'video' && (
          <video
            src={url}
            controls
            preload="metadata"
            playsInline
            className="h-full w-full bg-foreground"
            onError={() => setError('视频无法预览，请检查格式')}
          >
            <track kind="captions" />
          </video>
        )}
        {asset.kind === 'audio' && (
          <div className="flex flex-col items-center gap-4 py-5">
            <Music2 className="size-9 text-primary/70" />
            <audio
              src={url}
              controls
              preload="metadata"
              className="h-9 w-full"
              onError={() => setError('音频无法预览，请检查格式')}
            >
              <track kind="captions" />
            </audio>
          </div>
        )}
        {asset.kind === 'text' && (
          <button
            type="button"
            className="w-full p-4 text-left text-xs leading-6 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary"
            onClick={() => setExpanded(true)}
            aria-label={`查看${label}`}
          >
            <span className="line-clamp-5 whitespace-pre-wrap break-words">
              {textOverride ??
                (text === null ? '读取文本…' : text || '空文本文件')}
            </span>
          </button>
        )}
      </div>
      {error && (
        <p role="alert" className="px-3 pt-2 text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex min-w-0 shrink-0 items-center gap-2 px-3 py-2.5">
        <p
          className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground"
          title={asset.name}
        >
          {asset.name}
        </p>
      </div>
      {expanded && (
        <Modal
          title={displayName}
          onClose={() => setExpanded(false)}
          error={error}
        >
          <pre className="max-h-[50vh] overflow-y-auto whitespace-pre-wrap break-words font-sans text-sm leading-7">
            {textOverride ?? text}
          </pre>
        </Modal>
      )}
    </article>
  );
}
