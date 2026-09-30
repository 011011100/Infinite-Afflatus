import { FolderOpen, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { MAX_REFERENCES } from '../../../../shared/generation/draft';
import type { Asset, SaveJob } from '../../../../shared/models';
import { ReferenceCard, referenceLabels } from './reference-card';
import { ReferencePicker } from './reference-picker';

export function ReferenceShelf({
  projectId,
  assets,
  jobs,
  ids,
  importing,
  onImport,
  onChange,
  onInsert,
}: {
  projectId: string;
  assets: Asset[];
  jobs: SaveJob[];
  ids: string[];
  importing: boolean;
  onImport: () => void;
  onChange: (ids: string[]) => void;
  onInsert: (text: string) => void;
}) {
  const [picker, setPicker] = useState(false);
  const counts = { image: 0, video: 0, audio: 0, text: 0 };
  return (
    <aside className="flex min-h-0 flex-col" aria-label="参考素材">
      <div className="mb-4 flex items-center justify-between px-1">
        <h2 className="text-sm font-medium">
          参考素材{' '}
          {ids.length > 0 && (
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {ids.length}
            </span>
          )}
        </h2>
        <Button
          variant="ghost"
          size="icon-sm"
          title="从项目选择"
          aria-label="从项目选择素材"
          onClick={() => setPicker(true)}
          disabled={ids.length >= MAX_REFERENCES || importing}
        >
          <FolderOpen />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-1 pb-5">
        {ids.map((id) => {
          const asset = assets.find((item) => item.id === id);
          const remove = () => onChange(ids.filter((item) => item !== id));
          if (!asset) {
            const job = jobs.find((item) => item.id === id);
            return (
              <div
                key={id}
                className="flex items-center gap-2 rounded-xl border bg-card p-4 text-xs text-muted-foreground"
              >
                <span className="min-w-0 flex-1 break-words">
                  {job?.status === 'failed'
                    ? '保存失败，可返回画布重试'
                    : job
                      ? '素材正在保存…'
                      : '素材不可用，请重新选择'}
                </span>
                <Button
                  aria-label="移除不可用素材"
                  size="icon-xs"
                  variant="ghost"
                  onClick={remove}
                >
                  <X />
                </Button>
              </div>
            );
          }
          counts[asset.kind] += 1;
          return (
            <ReferenceCard
              key={id}
              projectId={projectId}
              asset={asset}
              label={`${referenceLabels[asset.kind]} ${counts[asset.kind]}`}
              onRemove={remove}
              onInsert={onInsert}
            />
          );
        })}
        <button
          type="button"
          className="generation-upload flex w-full flex-col items-center justify-center gap-3 rounded-xl border border-dashed bg-card/70 px-4 py-9 text-muted-foreground outline-none transition-colors hover:border-primary/40 hover:bg-muted/50 hover:text-primary focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          disabled={importing || ids.length >= MAX_REFERENCES}
          onClick={onImport}
        >
          <span className="grid size-9 place-items-center rounded-xl border bg-background shadow-sm">
            <Plus className="size-4" />
          </span>
          <span className="text-sm">
            {importing ? '正在导入…' : '上传素材'}
          </span>
          <span className="text-[11px] text-muted-foreground">
            图片 · 视频 · 音频 · 文本
          </span>
        </button>
      </div>
      {picker && (
        <ReferencePicker
          projectId={projectId}
          assets={assets}
          selectedIds={ids}
          remaining={MAX_REFERENCES - ids.length}
          onAdd={(added) => onChange([...ids, ...added])}
          onClose={() => setPicker(false)}
        />
      )}
    </aside>
  );
}
