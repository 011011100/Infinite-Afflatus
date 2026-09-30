import { ChevronDown, ChevronUp, Images, Ungroup } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { MaterialNode } from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import { ReferenceCard } from './reference-card';
import { useSpringTransform } from './use-spring-transform';

function ArcCard({
  distance,
  active,
  children,
}: {
  distance: number;
  active: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useSpringTransform(ref, {
    x: -Math.min(110, distance * distance * 24),
    y: distance * 172,
    rotate: distance * -7,
    scale: 1 - Math.min(0.28, Math.abs(distance) * 0.13),
    opacity: Math.max(0, 1 - Math.abs(distance) * 0.27),
  });
  return (
    <div
      ref={ref}
      className="material-arc-card"
      inert={!active}
      style={{ zIndex: 10 - Math.round(Math.abs(distance)) }}
      aria-hidden={!active}
    >
      {children}
    </div>
  );
}
export function MaterialArc({
  nodes,
  assets,
  projectId,
  disabled,
  detach,
}: {
  nodes: MaterialNode[];
  assets: Asset[];
  projectId: string;
  disabled: boolean;
  detach: (id: string) => void;
}) {
  const [activeId, setActiveId] = useState(nodes[0]?.id);
  const index = Math.max(
    0,
    nodes.findIndex((node) => node.id === activeId),
  );
  const area = useRef<HTMLDivElement>(null);
  const target = useRef(index);
  target.current = index;
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const accumulated = useRef(0);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const wheel = (event: WheelEvent) => {
      if (event.ctrlKey || !nodesRef.current.length) return;
      event.preventDefault();
      accumulated.current += event.deltaY * (event.deltaMode === 1 ? 16 : 1);
      if (Math.abs(accumulated.current) < 44) return;
      const next = Math.max(
        0,
        Math.min(
          nodesRef.current.length - 1,
          target.current + Math.sign(accumulated.current),
        ),
      );
      accumulated.current = 0;
      target.current = next;
      setActiveId(nodesRef.current[next]?.id);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, []);
  const change = (offset: number) => setActiveId(nodes[index + offset]?.id);
  return (
    <section className="material-arc" aria-label="参考素材">
      <div className="material-arc-heading">
        <span className="text-muted-foreground">
          {nodes.length ? `${index + 1} / ${nodes.length}` : '0'}
        </span>
      </div>
      <Button
        className="material-arc-up"
        variant="ghost"
        size="icon-sm"
        aria-label="上一个素材"
        disabled={index === 0}
        onClick={() => change(-1)}
      >
        <ChevronUp />
      </Button>
      <div ref={area} className="material-arc-window">
        {!nodes.length && (
          <div className="material-arc-empty">
            <Images className="mb-3 size-7 text-primary/50" />
            <span>暂无参考素材</span>
          </div>
        )}
        {nodes.map((node, i) => {
          if (Math.abs(i - index) > 3) return null;
          const asset =
            node.type === 'asset'
              ? assets.find((item) => item.id === node.assetId)
              : undefined;
          return (
            <ArcCard key={node.id} distance={i - index} active={i === index}>
              {asset ? (
                <ReferenceCard
                  key={`${node.id}:${node.id === nodes[index]?.id}`}
                  projectId={projectId}
                  asset={asset}
                  label="参考素材"
                  disabled={disabled}
                  onRemove={() => detach(node.id)}
                  removeLabel="移回画布"
                  removeIcon={<Ungroup />}
                />
              ) : (
                <div className="rounded-xl bg-card p-8 text-sm text-muted-foreground">
                  素材暂不可用
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={disabled}
                    onClick={() => detach(node.id)}
                  >
                    移回画布
                  </Button>
                </div>
              )}
            </ArcCard>
          );
        })}
      </div>
      <Button
        className="material-arc-down"
        variant="ghost"
        size="icon-sm"
        aria-label="下一个素材"
        disabled={index >= nodes.length - 1}
        onClick={() => change(1)}
      >
        <ChevronDown />
      </Button>
    </section>
  );
}
