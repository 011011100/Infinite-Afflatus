import { Check, Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import type { Asset } from '../../../../shared/models';
import { mediaUrl } from '../workspace/media';
import { referenceIcons, referenceLabels } from './reference-card';

export function ReferencePicker({
  projectId,
  assets,
  selectedIds,
  remaining,
  onAdd,
  onClose,
}: {
  projectId: string;
  assets: Asset[];
  selectedIds: string[];
  remaining: number;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState('');
  const available = assets.filter((asset) => !selectedIds.includes(asset.id));
  const visible = available.filter((asset) =>
    asset.name.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <Modal title="选择项目素材" onClose={onClose}>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-3 size-4 text-muted-foreground" />
        <Input
          aria-label="搜索项目素材"
          placeholder="搜索素材"
          className="pl-9"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <div className="grid max-h-[50vh] grid-cols-3 gap-3 overflow-y-auto p-1">
        {visible.map((asset) => {
          const Icon = referenceIcons[asset.kind];
          const checked = selected.includes(asset.id);
          return (
            <button
              type="button"
              key={asset.id}
              className={`relative min-w-0 rounded-xl border p-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring ${checked ? 'border-primary bg-muted' : 'bg-card hover:bg-secondary'}`}
              aria-pressed={checked}
              disabled={!checked && selected.length >= remaining}
              onClick={() =>
                setSelected((ids) =>
                  checked
                    ? ids.filter((id) => id !== asset.id)
                    : [...ids, asset.id],
                )
              }
            >
              <div className="mb-2 grid aspect-[4/3] place-items-center overflow-hidden rounded-lg bg-secondary text-muted-foreground">
                {asset.kind === 'image' ? (
                  <img
                    src={mediaUrl(projectId, asset.id)}
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
      </div>
      {!visible.length && (
        <p className="py-10 text-center text-sm text-muted-foreground">
          {query ? '没有匹配的素材' : '没有可添加的素材，可以先从本地上传'}
        </p>
      )}
      <div className="mt-5 flex items-center justify-between">
        <span className="text-xs text-muted-foreground">
          已选 {selected.length} 个
        </span>
        <Button
          disabled={!selected.length}
          onClick={() => {
            onAdd(selected);
            onClose();
          }}
        >
          添加素材
        </Button>
      </div>
    </Modal>
  );
}
