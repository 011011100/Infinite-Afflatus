import {
  MATERIAL_HEIGHT,
  MATERIAL_WIDTH,
  type Point,
  type ShotWorkspace,
} from './workspace';

/** Find nearby space without stacking a new card over another card or generation group. */
export function materialPosition(
  shot: ShotWorkspace,
  center: Point,
  count = 1,
): Point {
  const columns = Math.min(3, count);
  const width = columns * (MATERIAL_WIDTH + 24) - 24;
  const height = Math.ceil(count / columns) * (MATERIAL_HEIGHT + 24) - 24;
  const occupied = [
    ...shot.nodes
      .filter((node) => !node.groupId)
      .map((node) => ({
        ...node.position,
        width: MATERIAL_WIDTH,
        height: MATERIAL_HEIGHT,
      })),
    ...shot.groups.map((group) => ({
      ...group.position,
      width: group.width + 296,
      height: group.height,
    })),
  ];
  const origin = { x: center.x - width / 2, y: center.y - height / 2 };
  const free = (at: Point) =>
    occupied.every(
      (rect) =>
        at.x + width + 24 <= rect.x ||
        at.x >= rect.x + rect.width + 24 ||
        at.y + height + 24 <= rect.y ||
        at.y >= rect.y + rect.height + 24,
    );
  for (let radius = 0; radius < 100; radius++) {
    for (let y = -radius; y <= radius; y++) {
      for (let x = -radius; x <= radius; x++) {
        if (Math.max(Math.abs(x), Math.abs(y)) !== radius) continue;
        const at = {
          x: origin.x + x * (MATERIAL_WIDTH + 24),
          y: origin.y + y * (MATERIAL_HEIGHT + 24),
        };
        if (free(at)) return at;
      }
    }
  }
  return {
    x: origin.x,
    y: Math.max(0, ...occupied.map((rect) => rect.y + rect.height)) + 24,
  };
}
