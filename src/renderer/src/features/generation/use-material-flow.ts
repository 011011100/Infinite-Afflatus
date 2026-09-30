import type { NodeChange, NodePositionChange } from '@xyflow/react';
import { useCallback, useMemo, useState } from 'react';
import type { GenerationParameters } from '../../../../shared/generation/draft';
import {
  groupMaterials,
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  type Point,
  removeMaterial,
  type ShotWorkspace,
  ungroupMaterials,
} from '../../../../shared/generation/workspace';
import type { Asset } from '../../../../shared/models';
import type { GenerationGroupNode } from './generation-group';
import type { MaterialFlowNode } from './material-node';

export type MaterialCanvasNode = MaterialFlowNode | GenerationGroupNode;
export function useMaterialFlow(
  shot: ShotWorkspace,
  assets: Asset[],
  projectId: string,
  blocked: boolean,
  update: (change: (shot: ShotWorkspace) => ShotWorkspace) => void,
) {
  const [selected, setSelected] = useState<string[]>([]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [positions, setPositions] = useState<Record<string, Point>>({});
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
    update((current) => ungroupMaterials(current, id));
    setActiveGroup(null);
    setSelected([]);
  };
  const parameters = (id: string, value: GenerationParameters) =>
    update((current) => ({
      ...current,
      groups: current.groups.map((group) =>
        group.id === id ? { ...group, parameters: value } : group,
      ),
    }));
  const nodes: MaterialCanvasNode[] = [
    ...shot.groups.map((group) => ({
      id: group.id,
      type: 'generationGroup' as const,
      position: positions[group.id] ?? group.position,
      selected: selected.includes(group.id),
      style: { width: group.width, height: group.height },
      measured: { width: group.width, height: group.height },
      dragHandle: '.material-handle',
      data: {
        group,
        count: shot.nodes.filter((node) => node.groupId === group.id).length,
        open: activeGroup === group.id,
        blocked,
        toggle: setActiveGroup,
        ungroup,
        change: parameters,
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
      style: { width: MATERIAL_WIDTH, height: MATERIAL_HEIGHT },
      measured: { width: MATERIAL_WIDTH, height: MATERIAL_HEIGHT },
      dragHandle: '.material-handle',
      data: {
        material,
        asset:
          material.type === 'asset'
            ? assets.find((asset) => asset.id === material.assetId)
            : undefined,
        projectId,
        blocked,
        text,
        remove,
      },
    })),
  ];
  const onChanges = useCallback((changes: NodeChange<MaterialCanvasNode>[]) => {
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
      groups: current.groups.map((item) =>
        next.has(item.id)
          ? { ...item, position: next.get(item.id) ?? item.position }
          : item,
      ),
    }));
    setPositions({});
  };
  const freeIds = useMemo(
    () =>
      shot.nodes
        .filter((node) => selected.includes(node.id) && !node.groupId)
        .map((node) => node.id),
    [shot.nodes, selected],
  );
  const group = () => {
    if (!freeIds.length || blocked) return;
    const id = crypto.randomUUID();
    update((current) => groupMaterials(current, freeIds, id));
    setPositions({});
    setSelected([id]);
    setActiveGroup(id);
  };
  const contextNode = (_event: unknown, node: MaterialCanvasNode) => {
    if (!selected.includes(node.id)) setSelected([node.id]);
  };
  return {
    nodes,
    onChanges,
    selected,
    setSelected,
    freeIds,
    group,
    ungroup,
    activeGroup,
    setActiveGroup,
    contextNode,
    finishMove,
  };
}
