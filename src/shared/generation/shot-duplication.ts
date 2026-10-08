import { validateWorkspace } from './workspace';
import type { Point, ShotWorkspace } from './workspace-types';

export const MAX_SHOTS = 500;

function truncateName(value: string, limit: number): string {
  let result = '';
  for (const character of value) {
    if (result.length + character.length > limit) break;
    result += character;
  }
  return result;
}

function duplicateName(source: ShotWorkspace, shots: readonly ShotWorkspace[]) {
  const names = new Set(shots.map((shot) => shot.name));
  names.add(source.name);
  for (let ordinal = 1; ; ordinal++) {
    const suffix = ordinal === 1 ? ' 副本' : ` 副本 ${ordinal}`;
    const name = truncateName(source.name.trim(), 100 - suffix.length) + suffix;
    if (!names.has(name)) return name;
  }
}

/** Clone editing content, sharing only the underlying project asset references. */
export function duplicateShot(
  source: ShotWorkspace,
  shots: readonly ShotWorkspace[],
  position: Point,
): ShotWorkspace {
  if (shots.length >= MAX_SHOTS)
    throw new Error(`每个项目最多支持 ${MAX_SHOTS} 个镜头`);

  // Validation also creates an independent copy, preserving absent legacy fields.
  const [copy] = validateWorkspace({
    version: 1,
    revision: 0,
    shots: [{ ...source, position }],
  }).shots;
  if (!copy) throw new Error('镜头素材画布无效');

  const used = new Set<string>();
  for (const shot of [source, ...shots]) {
    used.add(shot.id);
    for (const group of shot.groups) used.add(group.id);
    for (const node of shot.nodes) used.add(node.id);
    for (const label of shot.labels ?? []) used.add(label.id);
  }
  const freshId = () => {
    let id = crypto.randomUUID();
    while (used.has(id)) id = crypto.randomUUID();
    used.add(id);
    return id;
  };

  copy.id = freshId();
  copy.name = duplicateName(source, shots);
  delete copy.sourceAssetId;
  const groups = new Map<string, string>();
  for (const group of copy.groups) {
    const id = freshId();
    groups.set(group.id, id);
    group.id = id;
  }
  for (const node of copy.nodes) {
    node.id = freshId();
    if (node.groupId !== undefined) {
      const groupId = groups.get(node.groupId);
      if (!groupId) throw new Error('素材节点的生成组不存在');
      node.groupId = groupId;
    }
  }
  for (const label of copy.labels ?? []) label.id = freshId();
  return copy;
}
