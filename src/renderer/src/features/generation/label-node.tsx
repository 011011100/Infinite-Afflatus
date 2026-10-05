import type { Node, NodeProps } from '@xyflow/react';
import { Pin, PinOff, X } from 'lucide-react';
import { stopCanvasControlKeys } from '@/components/canvas/keyboard-boundary';
import { Button } from '@/components/ui/button';
import { EditableName } from '@/components/ui/editable-name';
import type { CanvasLabel } from '../../../../shared/generation/workspace';

export type LabelFlowNode = Node<
  {
    label: CanvasLabel;
    blocked: boolean;
    change: (
      id: string,
      patch: Partial<Pick<CanvasLabel, 'name' | 'color' | 'pinned'>>,
    ) => void;
    remove: (id: string) => void;
  },
  'label'
>;

export function LabelCard({ id, data, selected }: NodeProps<LabelFlowNode>) {
  const { label, blocked, change } = data;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Only a bubbling boundary for nested controls; React Flow owns node keyboard interaction.
    <div
      onKeyDown={stopCanvasControlKeys}
      className="canvas-label material-handle flex h-full items-center gap-2 rounded-xl border bg-card px-3 shadow-sm"
      data-pinned={label.pinned}
      style={{
        borderColor: label.color,
        boxShadow: selected ? `0 0 0 2px ${label.color}40` : undefined,
      }}
    >
      <label
        className="nodrag nopan relative size-4 shrink-0 cursor-pointer overflow-hidden rounded-full"
        title="标签颜色"
        style={{ background: label.color }}
      >
        <input
          type="color"
          aria-label="标签颜色"
          value={label.color}
          disabled={blocked}
          onChange={(event) => change(id, { color: event.target.value })}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </label>
      <EditableName
        value={label.name}
        label="标签名称"
        disabled={blocked}
        onChange={(name) => change(id, { name })}
        className="text-sm font-medium"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        className="nodrag nopan shrink-0"
        disabled={blocked}
        aria-label={label.pinned ? '取消固定标签' : '固定标签'}
        aria-pressed={label.pinned}
        title={label.pinned ? '取消固定' : '固定在画布上'}
        onClick={() => change(id, { pinned: !label.pinned })}
      >
        {label.pinned ? (
          <Pin className="text-primary" />
        ) : (
          <PinOff className="text-muted-foreground" />
        )}
      </Button>
      {selected && (
        <Button
          variant="ghost"
          size="icon-xs"
          className="nodrag nopan absolute -right-2 -top-3 rounded-full border bg-card"
          disabled={blocked}
          aria-label="移除标签"
          onClick={() => data.remove(id)}
        >
          <X />
        </Button>
      )}
    </div>
  );
}
