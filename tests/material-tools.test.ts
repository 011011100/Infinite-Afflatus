import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  labelFlight,
  labelMarkers,
} from '../src/renderer/src/features/generation/labels/geometry';
import {
  detachMaterial,
  groupMaterials,
  materialSelection,
} from '../src/shared/generation/material-groups';
import { materialPosition } from '../src/shared/generation/material-layout';
import {
  groupGrid,
  materialSize,
  resizeMaterial,
} from '../src/shared/generation/node-geometry';
import {
  type CanvasLabel,
  emptyWorkspace,
  newShot,
  validateWorkspace,
} from '../src/shared/generation/workspace';
import {
  defaultInteractionSettings,
  upgradeInteractionSettings,
} from '../src/shared/interaction/settings';
import { shortcutAction } from '../src/shared/interaction/shortcuts';

const label = (id: string, x: number, y: number): CanvasLabel => ({
  id,
  name: id,
  color: '#ef4444',
  pinned: true,
  position: { x, y },
});
const view = { x: 0, y: 0, zoom: 1 };
const size = { width: 1200, height: 800 };

test('label markers preserve offscreen direction, zoom coordinates and separate nearby labels', () => {
  const labels = [
    label('north', 400, -2000),
    label('south', 400, 2000),
    label('west', -2000, 374),
    label('east', 2000, 374),
  ];
  const markers = labelMarkers(labels, view, size);
  assert.deepEqual(
    markers.map((m) => m.edge),
    ['top', 'bottom', 'left', 'right'],
  );
  for (const marker of markers) {
    assert.ok(marker.x >= 80 && marker.x <= size.width - 80);
    assert.ok(marker.y >= 16 && marker.y <= size.height - 16);
  }
  const overlapping = labelMarkers(
    Array.from({ length: 12 }, (_, i) => label(String(i), 400 + i, -2000)),
    view,
    size,
  );
  assert.equal(new Set(overlapping.map((m) => `${m.x}:${m.y}`)).size, 12);
  const centered = label('center', 490, 374);
  assert.equal(labelMarkers([centered], view, size)[0]?.edge, null);
  assert.equal(
    labelMarkers([centered], { x: -1000, y: 0, zoom: 0.5 }, size)[0]?.edge,
    'left',
  );
});

test('camera flight zooms around current center, moves at reduced scale and restores original zoom', () => {
  for (const zoom of [0.25, 0.7, 2]) {
    const from = { x: 100, y: 70, zoom };
    const target = label('target', 5000, -8000);
    const [out, pan, finish] = labelFlight(from, target, size);
    assert.ok(out && pan && finish);
    assert.ok(out.zoom <= zoom && out.zoom >= 0.25);
    assert.equal(
      (size.width / 2 - out.x) / out.zoom,
      (size.width / 2 - from.x) / from.zoom,
    );
    assert.equal(pan.zoom, out.zoom);
    assert.equal(finish.zoom, zoom);
    assert.equal(finish.x + (target.position.x + 110) * zoom, size.width / 2);
    assert.equal(finish.y + (target.position.y + 26) * zoom, size.height / 2);
  }
});

test('old documents remain valid; names, dimensions and labels survive validation with strict bounds', () => {
  const shot = newShot('shot', '镜头', { x: 0, y: 0 });
  const doc = { ...emptyWorkspace(), shots: [shot] };
  assert.deepEqual(validateWorkspace(doc), doc);
  shot.nodes = [
    {
      id: 'text',
      type: 'text',
      text: '内容',
      name: '卡片别名',
      width: 420,
      height: 360,
      position: { x: 100, y: 100 },
    },
  ];
  shot.labels = [label('label', -500, 500)];
  assert.deepEqual(validateWorkspace(doc), doc);
  for (const patch of [{ width: Infinity }, { height: 0 }, { name: '' }]) {
    assert.throws(() =>
      validateWorkspace({
        ...doc,
        shots: [{ ...shot, nodes: [{ ...shot.nodes[0], ...patch }] }],
      }),
    );
  }
  for (const patch of [
    { id: 'text' },
    { color: 'url(fake)' },
    { pinned: 'yes' },
  ]) {
    assert.throws(() =>
      validateWorkspace({
        ...doc,
        shots: [{ ...shot, labels: [{ ...shot.labels?.[0], ...patch }] }],
      }),
    );
  }
});

test('resized cards keep sizes through grouping/detachment; labels never become generation inputs', () => {
  let shot = newShot('shot', '镜头', { x: 0, y: 0 });
  shot.nodes = Array.from({ length: 7 }, (_, i) => ({
    id: `text-${i}`,
    type: 'text',
    text: '内容',
    position: { x: i * 300, y: 100 },
  }));
  shot.labels = [label('label', 100, 600)];
  shot = resizeMaterial(shot, 'text-0', { width: 600, height: 420 });
  shot = resizeMaterial(shot, 'text-3', { width: 500, height: 350 });
  const grouped = groupMaterials(
    shot,
    [...shot.nodes.map((n) => n.id), 'label'],
    'group',
  );
  assert.equal(materialSelection(grouped, ['label']).materials.length, 0);
  assert.deepEqual(grouped.labels, shot.labels);
  const grid = groupGrid(shot.nodes);
  for (const [i, a] of grid.positions.entries())
    for (const [j, b] of grid.positions.entries()) {
      if (i >= j) continue;
      const node = shot.nodes[i];
      assert.ok(node);
      const dimensions = materialSize(node);
      assert.ok(
        a.x + dimensions.width <= b.x || a.y + dimensions.height <= b.y,
      );
    }
  const grown = resizeMaterial(grouped, 'text-6', { width: 1100, height: 780 });
  const last = grown.nodes[6];
  assert.ok(last);
  assert.ok((grown.groups[0]?.height ?? 0) >= last.position.y + 780 + 20);
  const detached = detachMaterial(grown, 'text-0', { x: 100, y: 100 });
  assert.equal(detached.nodes[0]?.width, 600);
  assert.equal(detached.nodes[0]?.height, 420);
  assert.deepEqual(
    validateWorkspace({ ...emptyWorkspace(), shots: [detached] }).shots[0],
    detached,
  );
  const at = materialPosition(shot, { x: 300, y: 300 });
  assert.ok(
    at.x + 260 <= 100 || at.x >= 700 || at.y + 244 <= 100 || at.y >= 520,
  );
});

test('shortcut migration preserves existing custom bindings and disabled actions on both systems', () => {
  const { locateLabels: _, ...oldBindings } =
    defaultInteractionSettings().shortcuts;
  const old = { version: 1, longPressSplit: false, shortcuts: oldBindings };
  const settings = upgradeInteractionSettings(old);
  assert.deepEqual(settings.shortcuts.undo, old.shortcuts.undo);
  assert.ok(!Object.hasOwn(old.shortcuts, 'locateLabels'));
  for (const isMac of [true, false])
    assert.equal(
      shortcutAction(
        {
          key: 'l',
          ctrlKey: false,
          metaKey: false,
          shiftKey: false,
          altKey: false,
        },
        settings.shortcuts,
        isMac,
      ),
      'locateLabels',
    );
  const conflicting = {
    ...old,
    shortcuts: {
      ...oldBindings,
      play: { key: 'l', mod: false, shift: false, alt: false },
    },
  };
  assert.equal(
    upgradeInteractionSettings(conflicting).shortcuts.locateLabels,
    null,
  );
  assert.equal(
    upgradeInteractionSettings({
      ...settings,
      shortcuts: { ...settings.shortcuts, locateLabels: null },
    }).shortcuts.locateLabels,
    null,
  );
});
