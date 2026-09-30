import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Plus,
  Type,
  Ungroup,
} from 'lucide-react';
import { useLayoutEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import type { MaterialNode } from '../../../../shared/generation/workspace';
import { GroupTextInput } from './group-text-input';
import {
  TextBlockDropFeedback,
  TextBlockHoldFeedback,
} from './text-block-drag-feedback';
import { TextBlockPreview } from './text-block-preview';
import { useTextBlockDrag } from './use-text-block-drag';

export function GroupTextStack({
  nodes,
  projectId,
  disabled,
  full,
  focusId,
  edit,
  add,
  reorder,
  detach,
  onViewCanvas,
}: {
  nodes: MaterialNode[];
  projectId: string;
  disabled: boolean;
  full: boolean;
  focusId: string | null;
  edit: (id: string, text: string) => void;
  add: (text?: string) => void;
  reorder: (ids: string[]) => void;
  detach: (id: string, at?: { x: number; y: number }) => void;
  onViewCanvas: () => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const previous = useRef(new Map<string, number>());
  const ids = nodes.map((node) => node.id);
  const [returned, setReturned] = useState(0);
  const [detachedId, setDetachedId] = useState<string | null>(null);
  const moveToCanvas = (id: string, at?: { x: number; y: number }) => {
    detach(id, at);
    setDetachedId(id);
    setReturned((count) => count + 1);
  };
  const drag = useTextBlockDrag(
    surface,
    list,
    ids,
    disabled,
    reorder,
    moveToCanvas,
  );
  const order = drag.order ?? ids;
  const orderKey = order.join('|');
  useLayoutEffect(() => {
    if (!orderKey) previous.current.clear();
    const elements = [
      ...(list.current?.querySelectorAll<HTMLElement>('[data-text-block]') ??
        []),
    ];
    const rects = elements.map((el) => ({
      el,
      top: el.offsetTop,
      id: el.dataset.textBlock ?? '',
    }));
    for (const { el, id, top } of rects) {
      const before = previous.current.get(id);
      if (
        before !== undefined &&
        before !== top &&
        !matchMedia('(prefers-reduced-motion: reduce)').matches
      ) {
        el.getAnimations().forEach((animation) => {
          animation.cancel();
        });
        el.animate(
          [
            { transform: `translateY(${before - top}px)` },
            { transform: 'none' },
          ],
          { duration: 180, easing: 'cubic-bezier(.2,.8,.2,1)' },
        );
      }
    }
    previous.current = new Map(rects.map(({ id, top }) => [id, top]));
  }, [orderKey]);
  const move = (id: string, offset: number) => {
    const index = ids.indexOf(id);
    const next = [...ids];
    next.splice(index, 1);
    next.splice(index + offset, 0, id);
    reorder(next);
  };
  const liftedNode = nodes.find((node) => node.id === drag.lifted?.id);
  return (
    <>
      <div
        ref={surface}
        className="group-text-stack"
        data-dragging={!!drag.lifted}
        data-drag-outside={!!drag.lifted?.outside}
      >
        <header className="group-text-heading">
          <span className="flex items-center gap-2 text-sm font-medium">
            <Type className="size-4 text-primary" />
            镜头文本
          </span>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="添加文本块"
            disabled={disabled || full}
            onClick={() => add()}
          >
            <Plus />
          </Button>
        </header>
        <div ref={list} className="group-text-list">
          {order.map((id, index) => {
            const node = nodes.find((item) => item.id === id);
            return (
              node && (
                <div
                  key={id}
                  data-text-block={id}
                  data-lifted={drag.lifted?.id === id}
                  data-holding={drag.holding === id}
                  className="group-text-block"
                  onPointerDownCapture={(event) => drag.begin(event, id)}
                >
                  <div className="group-text-block-heading">
                    <button
                      type="button"
                      className="group-text-grip"
                      aria-label={`拖动文本块 ${index + 1}`}
                      title="长按拖动；移出卡片后松手移回画布"
                      disabled={disabled}
                      onKeyDown={(event) => {
                        if (event.key === 'ArrowUp' && index > 0) {
                          event.preventDefault();
                          move(id, -1);
                        }
                        if (
                          event.key === 'ArrowDown' &&
                          index < nodes.length - 1
                        ) {
                          event.preventDefault();
                          move(id, 1);
                        }
                      }}
                    >
                      <GripVertical className="size-4" />
                      <span>{String(index + 1).padStart(2, '0')}</span>
                    </button>
                    <div className="group-text-actions">
                      <Button
                        data-block-action
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`上移文本块 ${index + 1}`}
                        disabled={disabled || index === 0}
                        onClick={() => move(id, -1)}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        data-block-action
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`下移文本块 ${index + 1}`}
                        disabled={disabled || index === nodes.length - 1}
                        onClick={() => move(id, 1)}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        data-block-action
                        size="icon-xs"
                        variant="ghost"
                        aria-label={`移出文本块 ${index + 1}`}
                        title="移回画布"
                        disabled={disabled}
                        onClick={() => moveToCanvas(id)}
                      >
                        <Ungroup />
                      </Button>
                    </div>
                  </div>
                  <GroupTextInput
                    node={node}
                    index={index}
                    projectId={projectId}
                    focus={focusId === id}
                    disabled={disabled}
                    onChange={(text) => edit(id, text)}
                  />
                </div>
              )
            );
          })}
          {!nodes.length && (
            <Textarea
              aria-label="镜头文本"
              className="group-text-empty"
              placeholder="描述画面、动作、镜头和对白…"
              disabled={disabled || full}
              maxLength={10000}
              onChange={(event) => add(event.target.value)}
            />
          )}
        </div>
        <footer className="group-text-footer" aria-live="polite">
          {full ? '组合已达 32 个素材' : `${nodes.length || 1} 个文本块`}
        </footer>
      </div>
      <TextBlockPreview
        lifted={drag.lifted}
        detachedId={detachedId}
        text={
          liftedNode?.type === 'text'
            ? liftedNode.text || '空文本块'
            : (liftedNode?.textOverride ?? '文本文件')
        }
      />
      <TextBlockHoldFeedback
        hold={drag.holdFeedback}
        liftedId={drag.lifted?.id}
      />
      <TextBlockDropFeedback
        lifted={drag.lifted}
        returned={returned}
        onViewCanvas={onViewCanvas}
      />
    </>
  );
}
