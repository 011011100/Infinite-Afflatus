import { matchesSearch, searchWords } from '@/lib/search';
import type { Asset } from '../../../../shared/models';

export type ReferenceFilter = 'all' | Asset['kind'];
export type ReferenceSort = 'recent' | 'name';

export const referenceFilters: ReadonlyArray<{
  value: ReferenceFilter;
  label: string;
}> = [
  { value: 'all', label: '全部素材' },
  { value: 'image', label: '图片' },
  { value: 'video', label: '视频' },
  { value: 'audio', label: '音频' },
  { value: 'text', label: '文本' },
];

const kindLabels = new Map(
  referenceFilters.map(({ value, label }) => [value, label]),
);

const names = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
});

export function availableReferences(
  assets: readonly Asset[],
  selectedIds: readonly string[],
): Asset[] {
  const excluded = new Set(selectedIds);
  const unique = new Map<string, Asset>();
  for (const asset of assets) {
    if (!excluded.has(asset.id)) unique.set(asset.id, asset);
  }
  return [...unique.values()];
}

export function filterReferences(
  available: readonly Asset[],
  query: string,
  kind: ReferenceFilter,
  sort: ReferenceSort,
): Asset[] {
  const words = searchWords(query);
  const filtered = available.filter(
    (asset) =>
      (kind === 'all' || asset.kind === kind) &&
      matchesSearch(
        [asset.name, kindLabels.get(asset.kind) ?? asset.kind],
        words,
      ),
  );
  // Snapshots list assets by SQLite rowid, preserving insertion order.
  // Asset has no timestamp; reversing that order needs no new metadata.
  if (sort === 'recent') return filtered.reverse();
  return filtered.sort((left, right) =>
    names.compare(left.name.normalize('NFKC'), right.name.normalize('NFKC')),
  );
}

export function referenceLimit(remaining: number): number {
  return Number.isFinite(remaining) ? Math.max(0, Math.floor(remaining)) : 0;
}

export function selectedReferences(
  ids: readonly string[],
  available: readonly Asset[],
): Asset[] {
  const byId = new Map(available.map((asset) => [asset.id, asset]));
  return [...new Set(ids)].flatMap((id) => {
    const asset = byId.get(id);
    return asset ? [asset] : [];
  });
}
