import { Search, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import type { Asset } from '../../../../shared/models';
import { useMediaRevision } from '../workspace/use-media-revision';
import {
  ReferencePickerGrid,
  ReferencePickerSelection,
} from './reference-picker-list';
import {
  availableReferences,
  filterReferences,
  type ReferenceFilter,
  type ReferenceSort,
  referenceFilters,
  referenceLimit,
  selectedReferences,
} from './reference-picker-model';

export function ReferencePicker({
  projectId,
  assets,
  selectedIds,
  remaining,
  disabled = false,
  onAdd,
  onClose,
}: {
  projectId: string;
  assets: Asset[];
  selectedIds: string[];
  remaining: number;
  disabled?: boolean;
  onAdd: (ids: string[]) => void;
  onClose: () => void;
}) {
  useMediaRevision(projectId);
  const [selection, setSelection] = useState({
    projectId,
    ids: [] as string[],
  });
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<ReferenceFilter>('all');
  const [sort, setSort] = useState<ReferenceSort>('recent');
  const [showSelected, setShowSelected] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const submitting = useRef(false);
  const selectionId = useId();
  const available = useMemo(
    () => availableReferences(assets, selectedIds),
    [assets, selectedIds],
  );
  const selected = useMemo(
    () =>
      selectedReferences(
        selection.projectId === projectId ? selection.ids : [],
        available,
      ),
    [selection, projectId, available],
  );
  const visible = useMemo(
    () => filterReferences(available, query, kind, sort),
    [available, query, kind, sort],
  );
  const selectedSet = new Set(selected.map((asset) => asset.id));
  const hidden =
    selected.length -
    visible.filter((asset) => selectedSet.has(asset.id)).length;
  const limit = referenceLimit(remaining);
  const overLimit = Math.max(0, selected.length - limit);
  const invalidCount =
    selection.projectId === projectId
      ? selection.ids.length - selected.length
      : 0;
  const latest = useRef({
    projectId,
    available,
    limit,
    disabled,
    selection,
    onAdd,
  });
  latest.current = { projectId, available, limit, disabled, selection, onAdd };

  useEffect(() => {
    if (selection.projectId !== projectId) {
      setSelection({ projectId, ids: [] });
      setNotice(null);
      return;
    }
    if (!invalidCount) return;
    setSelection((previous) =>
      previous.projectId === projectId
        ? {
            projectId,
            ids: selectedReferences(previous.ids, available).map(
              (asset) => asset.id,
            ),
          }
        : previous,
    );
    setNotice(`${invalidCount} 个已选素材已不再可添加，已从本次选择中移除。`);
  }, [invalidCount, projectId, selection.projectId, available]);

  const toggle = (id: string) => {
    if (submitting.current) return;
    const current = latest.current;
    setSelection((previous) => {
      const ids = selectedReferences(
        previous.projectId === current.projectId ? previous.ids : [],
        current.available,
      ).map((asset) => asset.id);
      if (ids.includes(id))
        return {
          projectId: current.projectId,
          ids: ids.filter((item) => item !== id),
        };
      if (
        current.disabled ||
        ids.length >= current.limit ||
        !current.available.some((asset) => asset.id === id)
      )
        return previous;
      return { projectId: current.projectId, ids: [...ids, id] };
    });
    setNotice(null);
  };
  const add = (requestClose: () => void) => {
    const current = latest.current;
    if (submitting.current || current.disabled) return;
    const ids =
      current.selection.projectId === current.projectId
        ? current.selection.ids
        : [];
    const valid = selectedReferences(ids, current.available).map(
      (asset) => asset.id,
    );
    if (valid.length !== ids.length) {
      setSelection({ projectId: current.projectId, ids: valid });
      setNotice('可添加的素材已变化，请确认本次选择后再添加。');
      return;
    }
    if (!valid.length || valid.length > current.limit) return;
    submitting.current = true;
    setSubmitted(true);
    try {
      current.onAdd(valid);
      requestClose();
    } catch (error) {
      submitting.current = false;
      setSubmitted(false);
      setNotice(
        error instanceof Error ? error.message : '未能添加素材，请重试。',
      );
    }
  };
  const clearFilters = () => {
    setQuery('');
    setKind('all');
  };

  return (
    <Modal title="选择项目素材" onClose={onClose}>
      {(requestClose) => (
        <>
          <div className="relative mb-3">
            <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
            <Input
              aria-label="搜索项目素材"
              placeholder="搜索名称或类型，多个词用空格分开"
              className="pl-9 pr-10"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            {query && (
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute right-2 top-2"
                aria-label="清除素材搜索"
                onClick={() => setQuery('')}
              >
                <X />
              </Button>
            )}
          </div>
          <div className="mb-3 grid grid-cols-2 gap-3">
            <Select
              aria-label="素材类型"
              value={kind}
              onChange={(event) =>
                setKind(event.target.value as ReferenceFilter)
              }
            >
              {referenceFilters.map((filter) => (
                <option key={filter.value} value={filter.value}>
                  {filter.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="素材排序"
              value={sort}
              onChange={(event) => setSort(event.target.value as ReferenceSort)}
            >
              <option value="recent">最近添加</option>
              <option value="name">名称</option>
            </Select>
          </div>
          <div className="mb-2 flex min-h-7 items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>
              显示 {visible.length} / {available.length} 个可添加素材
            </span>
            {(query || kind !== 'all') && (
              <Button variant="ghost" size="sm" onClick={clearFilters}>
                清除筛选
              </Button>
            )}
          </div>
          {visible.length ? (
            <ReferencePickerGrid
              projectId={projectId}
              assets={visible}
              selected={selectedSet}
              cannotSelect={disabled || selected.length >= limit}
              submitted={submitted}
              toggle={toggle}
            />
          ) : (
            <div className="rounded-lg border border-dashed px-4 py-10 text-center">
              <p className="text-sm">
                {!assets.length
                  ? '项目中还没有素材'
                  : !available.length
                    ? '项目素材已全部使用'
                    : '没有符合条件的素材'}
              </p>
              <p className="mt-2 text-xs text-muted-foreground">
                {!assets.length
                  ? '先从本地导入图片、视频、音频或文本。'
                  : !available.length
                    ? '当前素材都已添加，可先导入其他素材。'
                    : '尝试其他关键词或素材类型；本次已选素材仍会保留。'}
              </p>
            </div>
          )}
          <div className="mt-4 border-t pt-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span role="status" className="text-xs text-muted-foreground">
                已选 {selected.length} 个
                {hidden ? `，其中 ${hidden} 个不在当前筛选结果中` : ''}
              </span>
              <div className="flex items-center gap-1">
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={showSelected}
                  aria-controls={selectionId}
                  onClick={() => setShowSelected(!showSelected)}
                >
                  {showSelected ? '收起已选' : '查看已选'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!selected.length || submitted}
                  onClick={() => {
                    setSelection({ projectId, ids: [] });
                    setNotice(null);
                  }}
                >
                  清空选择
                </Button>
              </div>
            </div>
            {showSelected && (
              <div id={selectionId}>
                <ReferencePickerSelection
                  assets={selected}
                  disabled={submitted}
                  onRemove={toggle}
                />
              </div>
            )}
            {notice && (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                {notice}
              </p>
            )}
            {disabled ? (
              <p role="alert" className="mt-2 text-xs text-warning-foreground">
                当前暂不能修改镜头，选择仍会保留。
              </p>
            ) : overLimit ? (
              <p role="alert" className="mt-2 text-xs text-warning-foreground">
                当前最多可添加 {limit} 个素材，请再取消选择 {overLimit} 个。
              </p>
            ) : limit === 0 ? (
              <p role="status" className="mt-2 text-xs text-muted-foreground">
                当前已没有可添加的名额。
              </p>
            ) : null}
          </div>
          <div className="mt-4 flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              本次最多可添加 {limit} 个
            </span>
            <Button
              disabled={
                disabled ||
                submitted ||
                !selected.length ||
                !!overLimit ||
                !!invalidCount
              }
              onClick={() => add(requestClose)}
            >
              添加素材
            </Button>
          </div>
        </>
      )}
    </Modal>
  );
}
