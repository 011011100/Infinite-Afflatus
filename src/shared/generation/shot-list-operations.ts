import { MAX_SHOTS } from './shot-duplication';
import { validateWorkspace } from './workspace';
import type { Point, ShotWorkspace } from './workspace-types';

export type ShotListOperation =
  | { type: 'insert'; shot: ShotWorkspace; index: number }
  | { type: 'remove'; id: string }
  | { type: 'move'; id: string; from: Point; to: Point };

const samePosition = (left: Point, right: Point) =>
  left.x === right.x && left.y === right.y;
const validPosition = (point: Point) =>
  !!point &&
  Number.isFinite(point.x) &&
  Number.isFinite(point.y) &&
  Math.abs(point.x) < 1e8 &&
  Math.abs(point.y) < 1e8;

/** Reverse the current operation, retaining edits made since an earlier history entry. */
export function applyShotListOperation(
  shots: readonly ShotWorkspace[],
  operation: ShotListOperation,
): { shots: ShotWorkspace[]; inverse: ShotListOperation } | null {
  if (operation.type === 'insert') {
    if (
      !Number.isInteger(operation.index) ||
      operation.index < 0 ||
      operation.index > shots.length
    )
      throw new Error('镜头插入位置无效');
    if (shots.length >= MAX_SHOTS)
      throw new Error(`每个项目最多支持 ${MAX_SHOTS} 个镜头`);
    if (shots.some((shot) => shot.id === operation.shot.id))
      throw new Error('镜头已存在，未重复添加');
    if (
      operation.shot.sourceAssetId !== undefined &&
      shots.some((shot) => shot.sourceAssetId === operation.shot.sourceAssetId)
    )
      throw new Error('此视频已关联其他镜头，未替换现有内容');
    const next = [...shots];
    next.splice(operation.index, 0, operation.shot);
    const validated = validateWorkspace({
      version: 1,
      revision: 0,
      shots: next,
    });
    const inserted = validated.shots[operation.index];
    if (!inserted) throw new Error('镜头插入位置无效');
    // The new shot is isolated from its history payload; unrelated shots retain
    // their live references, rather than adopting the validator's full copy.
    next[operation.index] = inserted;
    return { shots: next, inverse: { type: 'remove', id: inserted.id } };
  }

  const index = shots.findIndex((shot) => shot.id === operation.id);
  const shot = shots[index];
  if (!shot) throw new Error('镜头已不存在，请重新操作');
  if (operation.type === 'remove') {
    return {
      shots: shots.filter((_shot, position) => position !== index),
      inverse: { type: 'insert', shot: structuredClone(shot), index },
    };
  }
  if (!validPosition(operation.from) || !validPosition(operation.to))
    throw new Error('镜头坐标无效');
  if (!samePosition(shot.position, operation.from))
    throw new Error('镜头位置已变化，请重新操作');
  if (samePosition(operation.from, operation.to)) return null;
  return {
    shots: shots.map((current, position) =>
      position === index
        ? { ...current, position: { ...operation.to } }
        : current,
    ),
    inverse: {
      type: 'move',
      id: shot.id,
      from: { ...operation.to },
      to: { ...shot.position },
    },
  };
}
