import { Search, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Modal } from '@/components/ui/modal';
import { Select } from '@/components/ui/select';
import type { ShotWorkspace } from '../../../../../shared/generation/workspace';
import type { Asset } from '../../../../../shared/models';
import {
  buildMaterialSearchEntries,
  filterMaterialSearchEntries,
  type MaterialSearchFilter,
  materialSearchKinds,
} from './material-search-model';

export function MaterialSearchDialog({
  shot,
  assets,
  disabled = false,
  onChoose,
  onClose,
}: {
  shot: ShotWorkspace;
  assets: Asset[];
  disabled?: boolean;
  onChoose: (id: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<MaterialSearchFilter>('all');
  const [choosing, setChoosing] = useState(false);
  const chosen = useRef<{ shotId: string; id: string } | null>(null);
  const finished = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const entries = useMemo(
    () => buildMaterialSearchEntries(shot, assets),
    [shot, assets],
  );
  const visible = useMemo(
    () => filterMaterialSearchEntries(entries, query, kind),
    [entries, query, kind],
  );
  useEffect(() => {
    input.current?.focus({ preventScroll: true });
  }, []);
  const choose = (id: string | undefined, requestClose: () => void) => {
    if (!id || disabled || chosen.current || finished.current) return;
    chosen.current = { shotId: shot.id, id };
    setChoosing(true);
    requestClose();
  };
  const close = () => {
    if (finished.current) return;
    finished.current = true;
    const selection = chosen.current;
    onClose();
    if (
      selection?.shotId === shot.id &&
      !disabled &&
      entries.some((entry) => entry.id === selection.id)
    )
      onChoose(selection.id);
  };
  return (
    <Modal title="查找镜头素材" onClose={close}>
      {(requestClose) => (
        <>
          <p className="mb-4 text-xs text-muted-foreground">
            查找当前镜头的卡片名称、已编辑文本、标签与生成组。选择后定位到画布，不展开生成组。
          </p>
          <div className="mb-3 flex gap-3">
            <div className="relative min-w-0 flex-1">
              <Search className="pointer-events-none absolute left-3 top-3 size-4 text-muted-foreground" />
              <Input
                ref={input}
                type="search"
                aria-label="搜索镜头素材"
                placeholder="名称、文本或标签，可用空格组合关键词"
                className="pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
                value={query}
                disabled={disabled || choosing}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key !== 'Enter' ||
                    event.defaultPrevented ||
                    event.nativeEvent.isComposing ||
                    event.repeat
                  )
                    return;
                  event.preventDefault();
                  choose(visible[0]?.id, requestClose);
                }}
              />
              {query && (
                <Button
                  size="icon-xs"
                  variant="ghost"
                  className="absolute right-2 top-2"
                  aria-label="清除镜头搜索"
                  disabled={disabled || choosing}
                  onClick={() => {
                    setQuery('');
                    input.current?.focus();
                  }}
                >
                  <X />
                </Button>
              )}
            </div>
            <Select
              aria-label="镜头素材类型"
              value={kind}
              disabled={disabled || choosing}
              onChange={(event) =>
                setKind(event.target.value as MaterialSearchFilter)
              }
            >
              <option value="all">全部类型</option>
              {Object.entries(materialSearchKinds).map(([value, label]) => (
                <option key={value} value={value}>
                  {label}
                </option>
              ))}
            </Select>
          </div>
          <p role="status" className="mb-2 text-xs text-muted-foreground">
            {visible.length} / {entries.length} 个结果
          </p>
          {visible.length ? (
            <ul
              aria-label="镜头查找结果"
              className="max-h-[48vh] divide-y overflow-y-auto"
            >
              {visible.map((entry) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    data-material-search-id={entry.id}
                    aria-label={`定位${entry.typeLabel}：${entry.name}`}
                    disabled={disabled || choosing}
                    onClick={() => choose(entry.id, requestClose)}
                    className="w-full rounded-lg px-3 py-3 text-left outline-none hover:bg-secondary focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:opacity-50"
                  >
                    <span className="flex items-center gap-2">
                      <span className="shrink-0 text-[11px] text-muted-foreground">
                        {entry.typeLabel}
                      </span>
                      <span className="truncate text-sm font-medium">
                        {entry.name}
                      </span>
                    </span>
                    <span
                      className="mt-1 block truncate text-xs text-muted-foreground"
                      title={entry.context}
                    >
                      {entry.context}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <div className="py-10 text-center text-sm text-muted-foreground">
              <p>
                {entries.length
                  ? '没有找到匹配的镜头素材'
                  : '当前镜头还没有素材或标签'}
              </p>
              {(query || kind !== 'all') && (
                <Button
                  className="mt-2"
                  variant="ghost"
                  disabled={disabled || choosing}
                  onClick={() => {
                    setQuery('');
                    setKind('all');
                    input.current?.focus();
                  }}
                >
                  清除搜索与筛选
                </Button>
              )}
            </div>
          )}
        </>
      )}
    </Modal>
  );
}
