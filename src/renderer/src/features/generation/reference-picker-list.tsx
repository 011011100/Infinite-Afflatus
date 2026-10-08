import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { Asset } from '../../../../shared/models';
import { mediaUrl } from '../workspace/media';
import { mediaRevision } from '../workspace/use-media-revision';
import { referenceIcons, referenceLabels } from './reference-card';

export function ReferencePickerGrid({
  projectId,
  assets,
  selected,
  cannotSelect,
  submitted,
  toggle,
}: {
  projectId: string;
  assets: Asset[];
  selected: ReadonlySet<string>;
  cannotSelect: boolean;
  submitted: boolean;
  toggle: (id: string) => void;
}) {
  return (
    <fieldset
      aria-label="可添加的项目素材"
      className="grid min-w-0 max-h-[42vh] grid-cols-2 gap-3 overflow-y-auto border-0 p-1 sm:grid-cols-3"
    >
      {assets.map((asset) => {
        const Icon = referenceIcons[asset.kind];
        const checked = selected.has(asset.id);
        return (
          <button
            type="button"
            key={asset.id}
            data-reference-id={asset.id}
            className={`relative min-w-0 rounded-xl border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 ${checked ? 'border-primary bg-muted' : 'bg-card hover:bg-secondary'}`}
            aria-pressed={checked}
            aria-label={`${asset.name}，${referenceLabels[asset.kind]}`}
            disabled={submitted || (!checked && cannotSelect)}
            onClick={() => toggle(asset.id)}
          >
            <div className="mb-2 grid aspect-[4/3] place-items-center overflow-hidden rounded-lg bg-secondary text-muted-foreground">
              {asset.kind === 'image' ? (
                <img
                  src={mediaUrl(
                    projectId,
                    asset.id,
                    mediaRevision(projectId, asset.id),
                  )}
                  alt=""
                  loading="lazy"
                  className="size-full object-contain"
                />
              ) : (
                <Icon className="size-7" />
              )}
            </div>
            {checked && (
              <span className="absolute right-3 top-3 rounded-full bg-primary p-1 text-primary-foreground">
                <Check className="size-3" />
              </span>
            )}
            <p className="truncate text-xs" title={asset.name}>
              {asset.name}
            </p>
            <p className="mt-1 text-[11px] text-muted-foreground">
              {referenceLabels[asset.kind]}
            </p>
          </button>
        );
      })}
    </fieldset>
  );
}

export function ReferencePickerSelection({
  assets,
  disabled,
  onRemove,
}: {
  assets: Asset[];
  disabled: boolean;
  onRemove: (id: string) => void;
}) {
  return (
    <ul
      aria-label="本次已选素材"
      className="mt-3 max-h-36 space-y-1 overflow-y-auto rounded-lg border p-2"
    >
      {assets.length ? (
        assets.map((asset) => {
          const Icon = referenceIcons[asset.kind];
          return (
            <li key={asset.id} className="flex min-w-0 items-center gap-2 px-1">
              <Icon className="size-4 shrink-0 text-muted-foreground" />
              <span
                className="min-w-0 flex-1 truncate text-xs"
                title={asset.name}
              >
                {asset.name}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {referenceLabels[asset.kind]}
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`取消选择${asset.name}`}
                disabled={disabled}
                onClick={() => onRemove(asset.id)}
              >
                <X />
              </Button>
            </li>
          );
        })
      ) : (
        <li className="px-2 py-3 text-center text-xs text-muted-foreground">
          还没有选择素材
        </li>
      )}
    </ul>
  );
}
