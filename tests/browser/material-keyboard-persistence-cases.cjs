const assert = require('node:assert/strict');
const { existsSync } = require('node:fs');
const fs = require('node:fs/promises');
const { join } = require('node:path');

const page = 'section[aria-label$="素材子画布"]';
const settingsDialog = 'dialog[open]';
const labels = {
  moveRight: '向右移动（素材画布）',
  moveRightFast: '快速向右移动（素材画布）',
  moveUp: '向上移动（素材画布）',
  moveUpFast: '快速向上移动（素材画布）',
  undo: '撤销',
  redo: '重做',
};
const shortcut = (key, mod = false, shift = false) => ({
  key,
  mod,
  shift,
  alt: false,
});
const workspace = (c) => c.api('getGenerationWorkspace', c.seed.project.id);
const nodeSelector = (id) => `${page} .react-flow__node[data-id="${id}"]`;
const editable = (c) =>
  c.expected.workspace.shots.find((shot) => shot.id === c.seed.ids.shot);
const at = (c, id) => {
  const shot = editable(c);
  const item = [...shot.nodes, ...shot.groups, ...shot.labels].find(
    (entry) => entry.id === id,
  );
  assert.ok(item, `Unknown fixture node ${id}`);
  return item;
};
const sameDocument = (actual, expected) =>
  assert.deepEqual({ ...actual, revision: 0 }, { ...expected, revision: 0 });
async function saveExpected(c) {
  await fs.writeFile(
    join(c.base, 'expected.json'),
    JSON.stringify(c.expected, null, 2),
  );
}
async function saved(c, previousRevision) {
  const actual = await c.waitFor(async () => {
    const current = await workspace(c);
    if (current.revision <= previousRevision) return false;
    // Wait only for the target positions; once reached, compare the entire document.
    const shot = current.shots.find((item) => item.id === c.seed.ids.shot);
    const positions = (value) =>
      [...value.nodes, ...value.groups, ...value.labels].map(
        (item) => item.position,
      );
    if (
      JSON.stringify(positions(shot)) !== JSON.stringify(positions(editable(c)))
    )
      return false;
    return current;
  }, 'keyboard operation persisted through production workspace IPC');
  sameDocument(actual, c.expected.workspace);
  return actual;
}
async function openProject(c) {
  const name = JSON.stringify(c.seed.project.name);
  const entry = `[...document.querySelectorAll('button span')].filter(s=>s.textContent.trim()===${name})`;
  await c.waitFor(() => c.run(`${entry}.length===1`), 'unique project entry');
  await c.run(`void ${entry}[0].closest('button').click()`);
  await c.waitFor(
    () => c.run('!!document.querySelector("button[aria-label=返回项目首页]")'),
    'project canvas',
  );
  assert.equal(
    await c.run(
      'document.querySelector("button[title=修改项目名称]").textContent.trim()',
    ),
    c.seed.project.name,
  );
  assert.equal((await c.api('getLibrary')).projects.length, 2);
}
async function openMaterials(c) {
  const shot = `.react-flow__node[data-id="shot:${c.seed.ids.shot}"]`;
  await c.waitFor(
    () => c.run(`!!document.querySelector(${JSON.stringify(shot)})`),
    'known shot',
  );
  await c.run(
    `(() => { const b=[...document.querySelector(${JSON.stringify(shot)}).querySelectorAll('button')].find(b=>b.textContent.trim()==='素材画布');if(!b || b.disabled)throw Error('Shot unavailable');b.click(); })()`,
  );
  await c.waitFor(
    () =>
      c.run(
        `!!document.querySelector(${JSON.stringify(nodeSelector(c.seed.ids.text))})`,
      ),
    'known material canvas',
  );
  await c.waitFor(
    () =>
      c.run(
        `(() => {const image=document.querySelector(${JSON.stringify(`${nodeSelector(c.seed.ids.image)} img`)});return image?.complete && image.naturalWidth===1 && image.naturalHeight===1;})()`,
      ),
    'real synthetic PNG decoded through the production media protocol',
  );
  await c.frame();
}
async function select(c, id) {
  const selector = nodeSelector(id);
  await c.focus(selector);
  // Exercise React Flow's accessible Enter selection with a real key, not DOM data edits.
  await c.key('Return');
  await c.waitFor(
    () =>
      c.run(
        `(() => {const all=[...document.querySelectorAll(${JSON.stringify(`${page} .react-flow__node.selected`)})];return all.length===1 && all[0].dataset.id===${JSON.stringify(id)};})()`,
      ),
    'Enter selects exactly the intended material',
  );
}
async function step(c, id, code, modifiers, position) {
  const previous = await workspace(c);
  await select(c, id);
  at(c, id).position = position;
  await c.key(code, modifiers);
  await saved(c, previous.revision);
}
async function unchangedKeys(c, id, keys) {
  await select(c, id);
  const before = await workspace(c);
  const selector = JSON.stringify(nodeSelector(id));
  await c.run(`(() => {
    const e=document.querySelector(${selector});window.keyboardTransforms=[e.style.transform];
    window.keyboardTransformObserver=new MutationObserver(()=>window.keyboardTransforms.push(e.style.transform));
    window.keyboardTransformObserver.observe(e,{attributes:true,attributeFilter:['style']});
  })()`);
  try {
    for (const [key, modifiers] of keys) await c.key(key, modifiers);
    await c.sleep(450); // Cross the real autosave debounce, also checking transient RF movement.
    const transforms = await c.run('window.keyboardTransforms');
    assert.equal(
      new Set(transforms).size,
      1,
      'Unbound/pinned keys must not create transient position changes',
    );
    assert.deepEqual(
      await workspace(c),
      before,
      'Ignored key must neither mutate nor save the document',
    );
  } finally {
    await c.run('window.keyboardTransformObserver.disconnect()');
  }
}
async function returnHome(c) {
  await c.click('返回主画布');
  await c.waitFor(
    () => c.run(`!document.querySelector(${JSON.stringify(page)})`),
    'material return flushed',
  );
  await c.click('返回项目首页');
  await c.waitFor(
    () => c.run('!!document.querySelector("input[aria-label=新项目名称]")'),
    'home after save',
  );
}
async function settings(c) {
  await c.click('设置');
  await c.waitFor(
    () => c.run(`!!document.querySelector(${JSON.stringify(settingsDialog)})`),
    'settings modal',
  );
  await c.click('交互与快捷键');
}
const bindingSelector = (action) =>
  `${settingsDialog} button[aria-label^="${labels[action]}快捷键："]`;
async function setBinding(c, action, code, modifiers = []) {
  await c.nativeClick(bindingSelector(action));
  await c.waitFor(
    () =>
      c.run(
        `document.querySelector(${JSON.stringify(bindingSelector(action))}).textContent.includes('请按快捷键')`,
      ),
    'shortcut capture active',
  );
  await c.key(code, modifiers);
  await c.waitFor(
    () =>
      c.run(
        `!document.querySelector(${JSON.stringify(bindingSelector(action))}).textContent.includes('请按快捷键')`,
      ),
    'shortcut capture completed',
  );
}
async function assertPreferences(c) {
  assert.deepEqual(
    (await c.api('getLibrary')).interactions,
    c.expected.settings,
  );
  await settings(c);
  for (const [action, expected] of [
    ['moveRight', 'J'],
    ['moveRightFast', process.platform === 'darwin' ? '⇧ J' : 'Shift + J'],
    ['undo', process.platform === 'darwin' ? '⌘ U' : 'Ctrl + U'],
    ['redo', process.platform === 'darwin' ? '⌘ ⇧ U' : 'Ctrl + Shift + U'],
    ['moveUp', '未设置'],
    ['moveUpFast', '未设置'],
  ])
    assert.equal(
      await c.run(
        `document.querySelector(${JSON.stringify(bindingSelector(action))}).textContent.trim()`,
      ),
      expected,
    );
  await c.click('关闭');
  await c.waitFor(
    () => c.run(`!document.querySelector(${JSON.stringify(settingsDialog)})`),
    'settings closed',
  );
}

async function configure(c) {
  const initial = await c.api('createProject', '键盘持久化验收唯一项目');
  c.setChoice([join(c.base, '键盘 原图.png'), join(c.base, '键盘 原文.txt')]);
  const imported = await c.api(
    'importReferences',
    initial.project.id,
    c.randomUUID(),
  );
  assert.equal(imported.assetIds.length, 2);
  assert.deepEqual(imported.errors, []);
  await c.waitFor(
    async () =>
      (await c.api('getLibrary')).jobs.every((job) => job.status === 'saved'),
    'real reference assets saved',
  );
  const snapshot = await c.api('openProject', initial.project.id);
  assert.deepEqual(snapshot.assets.map((asset) => asset.kind).sort(), [
    'image',
    'text',
  ]);
  const ids = Object.fromEntries(
    [
      'shot',
      'text',
      'member',
      'image',
      'reference',
      'group',
      'label',
      'otherShot',
      'otherText',
    ].map((name) => [name, c.randomUUID()]),
  );
  const draft = await c.api('getGenerationWorkspace', initial.project.id);
  draft.shots.push(
    {
      id: ids.shot,
      name: '键盘移动与保存镜头',
      position: { x: 100, y: 100 },
      viewport: { x: 30, y: 30, zoom: 0.85 },
      nodes: [
        {
          id: ids.text,
          type: 'text',
          name: '独立文字',
          text: '原始独立文字不可丢失',
          position: { x: 20, y: 30 },
        },
        {
          id: ids.member,
          type: 'text',
          name: '组合文字',
          text: '组内参数和相对坐标保持',
          groupId: ids.group,
          position: { x: 20, y: 52 },
        },
        {
          id: ids.image,
          type: 'asset',
          assetId: snapshot.assets.find((asset) => asset.kind === 'image').id,
          groupId: ids.group,
          position: { x: 450, y: 52 },
          width: 260,
          height: 244,
        },
        {
          id: ids.reference,
          type: 'asset',
          assetId: snapshot.assets.find((asset) => asset.kind === 'text').id,
          textOverride: '项目中的文字覆写，源文不变',
          position: { x: 20, y: 330 },
        },
      ],
      groups: [
        {
          id: ids.group,
          position: { x: 350, y: 30 },
          width: 720,
          height: 340,
          parameters: {
            model: 'seedance-2.0',
            ratio: '9:16',
            resolution: '1080p',
            duration: 8,
            generateAudio: true,
          },
        },
      ],
      labels: [
        {
          id: ids.label,
          name: '固定位置验收',
          color: '#f59e0b',
          pinned: true,
          position: { x: 400, y: 450 },
        },
      ],
    },
    {
      id: ids.otherShot,
      name: '另一镜头不能改变',
      position: { x: 500, y: 100 },
      viewport: { x: 0, y: 0, zoom: 1 },
      nodes: [
        {
          id: ids.otherText,
          type: 'text',
          text: '另一镜头的原始内容',
          position: { x: 40, y: 60 },
        },
      ],
      groups: [],
      labels: [],
    },
  );
  const stored = await c.api(
    'saveGenerationWorkspace',
    initial.project.id,
    draft,
  );
  sameDocument(stored, draft);
  const independent = await c.api('createProject', '完全独立的键盘保护项目');
  const defaults = (await c.api('getLibrary')).interactions;
  for (const [direction, key] of [
    ['Left', 'arrowleft'],
    ['Right', 'arrowright'],
    ['Up', 'arrowup'],
    ['Down', 'arrowdown'],
  ]) {
    assert.deepEqual(defaults.shortcuts[`move${direction}`], shortcut(key));
    assert.deepEqual(
      defaults.shortcuts[`move${direction}Fast`],
      shortcut(key, false, true),
    );
  }
  c.seed = {
    project: initial.project,
    snapshot,
    independent,
    ids,
    workspace: stored,
  };
  c.expected = {
    workspace: structuredClone(stored),
    settings: structuredClone(defaults),
  };
  await fs.writeFile(
    join(c.base, 'seed.json'),
    JSON.stringify(c.seed, null, 2),
    { flag: 'wx' },
  );
  await openProject(c);
  await openMaterials(c);
  await step(c, ids.text, 'Right', [], { x: 25, y: 30 });
  await step(c, ids.text, 'Down', ['shift'], { x: 25, y: 50 });
  let previous = await workspace(c);
  at(c, ids.text).position = { x: 25, y: 30 };
  await c.key('Z', [c.mod]);
  await saved(c, previous.revision);
  previous = await workspace(c);
  at(c, ids.text).position = { x: 25, y: 50 };
  await c.key('Z', [c.mod, 'shift']);
  await saved(c, previous.revision);
  await returnHome(c);
  await settings(c);
  await setBinding(c, 'moveRight', 'J');
  await setBinding(c, 'moveRightFast', 'J', ['shift']);
  await setBinding(c, 'undo', 'U', [c.mod]);
  await setBinding(c, 'redo', 'U', [c.mod, 'shift']);
  for (const action of ['moveUp', 'moveUpFast'])
    await c.click(`清除${labels[action]}快捷键`);
  // Cancelling capture leaves the new J binding and keeps the settings modal open.
  await c.nativeClick(bindingSelector('moveRight'));
  await c.key('Escape');
  assert.equal(
    await c.run(
      `document.querySelector(${JSON.stringify(bindingSelector('moveRight'))}).textContent.trim()`,
    ),
    'J',
  );
  c.expected.settings.shortcuts.moveRight = shortcut('j');
  c.expected.settings.shortcuts.moveRightFast = shortcut('j', false, true);
  c.expected.settings.shortcuts.undo = shortcut('u', true);
  c.expected.settings.shortcuts.redo = shortcut('u', true, true);
  c.expected.settings.shortcuts.moveUp = null;
  c.expected.settings.shortcuts.moveUpFast = null;
  await c.click('保存设置');
  await c.waitFor(
    async () =>
      JSON.stringify((await c.api('getLibrary')).interactions) ===
      JSON.stringify(c.expected.settings),
    'custom settings persisted',
  );
  await c.click('关闭');
  await saveExpected(c);
  console.log(
    'PASS keyboard configure: real assets and two shots; default 5/20 steps with single-step undo/redo saved; custom/cleared bindings saved through settings, Escape cancels capture',
  );
}

async function restartEdit(c) {
  const { ids } = c.seed;
  await assertPreferences(c);
  await openProject(c);
  await openMaterials(c);
  await unchangedKeys(c, ids.text, [
    ['Right', []],
    ['Right', ['shift']],
    ['Up', []],
    ['Up', ['shift']],
  ]);
  await step(c, ids.text, 'J', [], { x: 30, y: 50 });
  await step(c, ids.text, 'J', ['shift'], { x: 50, y: 50 });
  let previous = await workspace(c);
  at(c, ids.text).position = { x: 30, y: 50 };
  await c.key('U', [c.mod]);
  await saved(c, previous.revision);
  previous = await workspace(c);
  at(c, ids.text).position = { x: 50, y: 50 };
  await c.key('U', [c.mod, 'shift']);
  await saved(c, previous.revision);
  await step(c, ids.group, 'J', ['shift'], { x: 370, y: 30 });
  await step(c, ids.image, 'J', [], { x: 455, y: 52 });
  await step(c, ids.image, 'J', ['shift'], { x: 460, y: 52 });
  await unchangedKeys(c, ids.image, [['J', ['shift']]]);
  await unchangedKeys(c, ids.label, [
    ['J', []],
    ['J', ['shift']],
  ]);
  // Text controls retain caret navigation; selected parent must not receive its arrows.
  await select(c, ids.text);
  const beforeInput = await workspace(c);
  await c.focus(`${nodeSelector(ids.text)} textarea`);
  await c.key('Left');
  await c.sleep(450);
  assert.deepEqual(await workspace(c), beforeInput);
  await select(c, ids.text);
  at(c, ids.text).position = { x: 55, y: 50 };
  await c.key('J');
  await saveExpected(c);
  c.allowNativeClose();
  c.window.close();
  await c.waitFor(
    () => c.window.isDestroyed(),
    'native close flushes final keyboard step',
  );
  console.log(
    'PASS keyboard restart/edit: actual custom keys, no old-arrow transient drift, exact group/child clamp, pinned/input isolation, custom undo/redo, final step followed by native close',
  );
}

async function restartFailure(c) {
  await openProject(c);
  await openMaterials(c);
  await select(c, c.seed.ids.text);
  const database = join(
    c.base,
    'projects',
    c.seed.project.folder,
    'project.sqlite',
  );
  const displaced = join(c.base, 'keyboard-displaced.sqlite');
  assert.equal(existsSync(displaced), false);
  const original = await c.hash(database);
  await fs.rename(database, displaced);
  try {
    at(c, c.seed.ids.text).position = { x: 60, y: 50 };
    await c.key('J');
    await c.waitFor(
      () => c.run('!!document.querySelector("[data-project-unavailable]")'),
      'real unavailable database after keyboard write',
    );
    assert.equal(
      existsSync(database),
      false,
      'Keyboard save must never recreate missing project SQLite',
    );
    const retained = await c.waitFor(async () => {
      const listing = await c.api('listWorkspaceDrafts', c.seed.project.id);
      assert.deepEqual(listing.issues, []);
      return listing.drafts.find(
        (record) =>
          !record.saved &&
          record.workspace.shots.some((shot) =>
            shot.nodes.some(
              (node) => node.id === c.seed.ids.text && node.position.x === 60,
            ),
          ),
      );
    }, 'real independent durable keyboard draft');
    sameDocument(retained.workspace, c.expected.workspace);
    await c.click('返回主画布');
    await c.sleep(150);
    assert.equal(
      await c.run(`!!document.querySelector(${JSON.stringify(page)})`),
      true,
      'Failed flush keeps the original material editor',
    );
    c.window.close();
    await c.waitFor(
      () =>
        !c.window.isDestroyed() &&
        c.run(
          'document.body.textContent.includes("仍有修改未保存") && !document.querySelector("[data-save-before-leave]")',
        ),
      'native close refuses unsaved keyboard draft',
    );
    assert.equal(c.window.isDestroyed(), false);
    assert.equal(
      await c.hash(displaced),
      original,
      'Failed save and refused leave preserve original database bytes',
    );
  } finally {
    // Restore only the original fixture file; never replace a path created by a bug.
    assert.equal(
      existsSync(database),
      false,
      'Refusing to overwrite unexpected project SQLite',
    );
    await fs.rename(displaced, database);
  }
  await c.click('重试读取项目');
  await c.waitFor(
    () => c.run('!document.querySelector("[data-project-unavailable]")'),
    'original project recovery accepted',
  );
  await saved(c, c.expected.workspace.revision);
  // The material error and global leave failure can briefly expose two buttons
  // with this label while the successful DB write finishes draft acknowledgement.
  // Retry the global native-close failure, not the material-only save handler.
  const leaveRetry = 'body > div[role="alert"] button';
  assert.equal(
    await c.run(
      `document.querySelector(${JSON.stringify(leaveRetry)}).closest('[role="alert"]').textContent.includes('仍有修改未保存')`,
    ),
    true,
  );
  await c.nativeClick(leaveRetry);
  await c.waitFor(
    () => c.run('!document.body.textContent.includes("仍有修改未保存")'),
    'native close failure cleared',
  );
  await returnHome(c);
  await saveExpected(c);
  console.log(
    'PASS keyboard storage fault: actual SQLite loss, durable target positions, failed material return and native close retain editor; original database retry saves draft without changing unrelated fields',
  );
}

async function exercise(c) {
  sameDocument(await workspace(c), c.expected.workspace);
  const source = await c.api('openProject', c.seed.project.id);
  assert.deepEqual(source.assets, c.seed.snapshot.assets);
  assert.deepEqual(source.canvas, c.seed.snapshot.canvas);
  assert.equal(source.project.name, c.seed.project.name);
  assert.deepEqual(
    await c.api('openProject', c.seed.independent.project.id),
    c.seed.independent,
  );
  assert.deepEqual(
    (await c.api('getLibrary')).interactions,
    c.expected.settings,
  );
  if (c.mode === 'restart-edit') return restartEdit(c);
  if (c.mode === 'restart-failure') return restartFailure(c);
  await assertPreferences(c);
  await openProject(c);
  await openMaterials(c);
  sameDocument(await workspace(c), c.expected.workspace);
  await returnHome(c);
  const drafts = await c.waitFor(async () => {
    const result = await c.api('listWorkspaceDrafts', c.seed.project.id);
    assert.deepEqual(result.issues, []);
    return result.drafts.length === 0 ? result : false;
  }, 'confirmed draft cleanup completed');
  assert.deepEqual(drafts, { drafts: [], issues: [] });
  console.log(
    'PASS keyboard final reopen: exact intended positions, group membership/parameters, text/image references, fixed label and second shot retained; custom settings persist and confirmed recovery copy is cleared',
  );
}

module.exports = { configure, exercise };
