import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { usePendingSave } from '@/features/lifecycle/use-pending-save';
import { cn } from '@/lib/utils';
import { Input } from './input';

/** An instance name: committing it never renames the underlying media file. */
export function EditableName({
  value,
  onChange,
  disabled,
  label = '卡片名称',
  className,
}: {
  value: string;
  onChange: (name: string) => void;
  disabled?: boolean;
  label?: string;
  className?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const editing = draft !== null;
  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);
  const commit = () => {
    const name = draft?.trim();
    if (name && name !== value) {
      if (disabled) return false;
      onChange(name);
    }
    setDraft(null);
    return true;
  };
  usePendingSave(`名称输入:${label}`, () => Promise.resolve(commit()), -20);
  if (draft !== null)
    return (
      <Input
        ref={input}
        aria-label={label}
        className={cn(
          'nodrag nopan nowheel h-7 min-w-0 flex-1 px-1 text-xs',
          className,
        )}
        value={draft}
        maxLength={100}
        readOnly={disabled}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
          }
        }}
      />
    );
  return (
    <div
      className={cn(
        'group/name flex min-w-0 flex-1 items-center gap-1',
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate" title={value}>
        {value}
      </span>
      <button
        type="button"
        className="nodrag nopan shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity group-hover/name:opacity-100 focus-visible:opacity-100 hover:text-primary focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none"
        aria-label={`重命名${label}`}
        title="重命名"
        disabled={disabled}
        onClick={() => setDraft(value)}
      >
        <Pencil className="size-3" />
      </button>
    </div>
  );
}
