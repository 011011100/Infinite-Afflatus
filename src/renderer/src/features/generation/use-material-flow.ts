import type { NodeChange, NodePositionChange } from '@xyflow/react';
import { useCallback, useMemo, useState } from 'react';
import {
  detachMaterial,
  materialSelection,
} from '../../../../shared/generation/material-groups';
import {
  LABEL_SIZE,
  materialSize,
  type Size,
} from '../../../../shared/generation/node-geometry';
import {
  groupMaterials,
  type Point,
  removeMaterial,
  type ShotWorkspace,
  ungroupMaterials,
} from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import type { GenerationGroupNode } from './generation-group';
import type { LabelFlowNode } from './label-node';
import type { MaterialFlowNode } from './material-node';
import { useMaterialNodeEdits } from './use-material-node-edits';

export type MaterialCanvasNode =
  | MaterialFlowNode
  | GenerationGroupNode
  | LabelFlowNode;
export function useMaterialFlow(
  shot: ShotWorkspace,
  assets: Asset[],
  projectId: string,
  blocked: boolean,
  longPressSplit: boolean,
  update: (change: (shot: ShotWorkspace) => ShotWorkspace) => void,
) {
  const [selected, setSelected] = useState<string[]>([]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [detached, setDetached] = useState<{
    id: string;
    groupId?: string;
  } | null>(null);
  const [measurements, setMeasurements] = useState<Record<string, Size>>({});
  const [positions, setPositions] = useState<Record<string, Point>>({});
  const { sizes, rename, resize, labelChange, labelRemove, groupSize } =
    useMaterialNodeEdits(shot, blocked, update);
  const remove = (id: string) =>
    update((current) => removeMaterial(current, id));
  const text = (id: string, value: string) =>
    update((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id && node.type === 'text'
          ? { ...node, text: value }
          : node,
      ),
    }));
  const ungroup = (id: string) => {
    if (blocked) return;
    update((current) => ungroupMaterials(current, id));
    setActiveGroup(null);
    setSelected([]);
  };
  const detach = (id: string, center?: Point) => {
    if (blocked) return;
    const material = shot.nodes.find((node) => node.id === id);
    if (!material?.groupId) return;
    update((current) => detachMaterial(current, id, center));
    setPositions({});
    setSelected([id]);
    setDetached({ id, groupId: material.groupId });
    if (
      activeGroup === material.groupId &&
      !shot.nodes.some(
        (node) => node.id !== id && node.groupId === material.groupId,
      )
    )
      setActiveGroup(null);
  };
  const nodes: MaterialCanvasNode[] = [
    ...shot.groups.map((group) => ({
      id: group.id,
      type: 'generationGroup' as const,
      position: positions[group.id] ?? group.position,
      selected: selected.includes(group.id),
      style: groupSize(group.id, group),
      measured: measurements[group.id] ?? groupSize(group.id, group),
      dragHandle: '.material-handle',
      data: {
        group,
        count: shot.nodes.filter((node) => node.groupId === group.id).length,
        open: activeGroup === group.id,
        blocked,
        toggle: setActiveGroup,
        ungroup,
      },
    })),
    ...shot.nodes.map((material) => ({
      id: material.id,
      type: 'material' as const,
      position: positions[material.id] ?? material.position,
      ...(material.groupId
        ? { parentId: material.groupId, extent: 'parent' as const }
        : {}),
      selected: selected.includes(material.id),
      style: sizes[material.id] ?? materialSize(material),
      measured:
        measurements[material.id] ??
        sizes[material.id] ??
        materialSize(material),
      dragHandle: '.material-handle',
      data: {
        material,
        asset:
          material.type === 'asset'
            ? assets.find((asset) => asset.id === material.assetId)
            : undefined,
        projectId,
        blocked,
        longPressSplit,
        select: (id: string) => setSelected([id]),
        detach,
        text,
        remove,
        rename,
        resize,
      },
    })),
    ...(shot.labels ?? []).map((label) => ({
      id: label.id,
      type: 'label' as const,
      position: positions[label.id] ?? label.position,
      selected: selected.includes(label.id),
      draggable: !blocked && !label.pinned,
      dragHandle: '.material-handle',
      style: LABEL_SIZE,
      measured: LABEL_SIZE,
      data: { label, blocked, change: labelChange, remove: labelRemove },
    })),
  ];
  const onChanges = useCallback((changes: NodeChange<MaterialCanvasNode>[]) => {
    const dimensions = changes.filter((change) => change.type === 'dimensions');
    if (dimensions.length)
      setMeasurements((current) => {
        const next = { ...current };
        let changed = false;
        for (const change of dimensions)
          if (
            change.dimensions &&
            (next[change.id]?.width !== change.dimensions.width ||
              next[change.id]?.height !== change.dimensions.height)
          ) {
            next[change.id] = change.dimensions;
            changed = true;
          }
        return changed ? next : current;
      });
    const selections = changes.filter((change) => change.type === 'select');
    if (selections.length)
      setSelected((current) => {
        const next = new Set(current);
        for (const change of selections) {
          if (change.selected) next.add(change.id);
          else next.delete(change.id);
        }
        return [...next];
      });
    const moved = changes.filter(
      (change): change is NodePositionChange & { position: Point } =>
        change.type === 'position' && Boolean(change.position),
    );
    if (moved.length)
      setPositions((current) => ({
        ...current,
        ...Object.fromEntries(
          moved.map((change) => [change.id, change.position]),
        ),
      }));
  }, []);
  const finishMove = (
    _event: unknown,
    node: MaterialCanvasNode,
    moved: MaterialCanvasNode[],
  ) => {
    const next = new Map(
      (moved.length ? moved : [node]).map((item) => [item.id, item.position]),
    );
    update((current) => ({
      ...current,
      nodes: current.nodes.map((item) =>
        next.has(item.id)
          ? { ...item, position: next.get(item.id) ?? item.position }
          : item,
      ),
      labels: (current.labels ?? []).map((item) =>
        !item.pinned && next.has(item.id)
          ? { ...item, position: next.get(item.id) ?? item.position }
          : item,
      ),
      groups: current.groups.map((item) =>
        next.has(item.id)
          ? { ...item, position: next.get(item.id) ?? item.position }
          : item,
      ),
    }));
    setPositions({});
  };
  const grouping = useMemo(
    () => materialSelection(shot, selected),
    [shot, selected],
  );
  const group = () => {
    if (!grouping.canGroup || blocked) return;
    const id = crypto.randomUUID();
    update((current) => groupMaterials(current, selected, id, activeGroup));
    setPositions({});
    setSelected([id]);
    setActiveGroup(null);
  };
  return {
    nodes,
    onChanges,
    selected,
    setSelected,
    grouping,
    group,
    ungroup,
    detach,
    detached,
    activeGroup,
    setActiveGroup,
    finishMove,
  };
}
