const assert = require('node:assert/strict');
const a = '10000000-0000-4000-8000-000000000001';
const b = '10000000-0000-4000-8000-000000000002';
const cardA = '20000000-0000-4000-8000-000000000001';
const cardB = '20000000-0000-4000-8000-000000000002';
const text = (page, id) =>
  `${page} .react-flow__node[data-id="${id}"] textarea`;
const shape = (shot) => ({
  nodes: shot.nodes.map(({ id: _, groupId, ...node }) => ({
    ...node,
    ...(groupId === undefined
      ? {}
      : { groupIndex: shot.groups.findIndex((group) => group.id === groupId) }),
  })),
  groups: shot.groups.map(({ id: _, ...group }) => group),
  labels: shot.labels?.map(({ id: _, ...label }) => label),
});
const content = ({ position: _, ...shot }) => shot;
const cardSet = (cards) =>
  [...cards].sort((left, right) => left.id.localeCompare(right.id));

async function runCases(h) {
  const {
    run,
    state,
    wait,
    paint,
    click,
    key,
    input,
    button,
    drag,
    reveal,
    openShot,
    back,
    mainHistory,
    remove,
    load,
    main,
    page,
  } = h;
  const rename = async (name, enter = true) => {
    await click(`${page} button[aria-label="重命名镜头名称"]`);
    await input(`${page} input[aria-label="镜头名称"]`, name);
    if (enter) await key('Return');
  };
  const count = async (value) =>
    wait(
      `projectHistory.state().stored.shots.length===${value}&&document.querySelector(${JSON.stringify(main)})?.getAttribute('aria-busy')!=='true'`,
      `saved shot count ${value}`,
    );
  const savedText = async (id, value) =>
    wait(
      `projectHistory.state().stored.shots.find(s=>s.id===${JSON.stringify(id)})?.nodes.some(n=>n.type==='text'&&n.text===${JSON.stringify(value)})`,
      `saved latest text ${value}`,
    );
  const enabled = (label) =>
    run(
      `document.querySelector(${JSON.stringify(`${main} fieldset[aria-label="画布操作"] button[aria-label="${label}"]`)})?.disabled===false`,
    );
  const assertBaselineProtected = async () => {
    const s = await state();
    assert.deepEqual(s.remote.assets, s.initialSnapshot.assets);
    assert.deepEqual(
      s.stored.shots.find((shot) => shot.id === 'associated-shot'),
      s.initialWorkspace.shots[1],
    );
  };
  const join = async () => {
    const second = `${main} [data-video-card="${cardB}"] footer > span`;
    await reveal(second);
    const delta = await run(
      `(()=>{const first=document.querySelector(${JSON.stringify(`${main} [data-video-card="${cardA}"]`)}).getBoundingClientRect(),second=document.querySelector(${JSON.stringify(`${main} [data-video-card="${cardB}"]`)}).getBoundingClientRect();return {x:first.right-second.left,y:first.top-second.top,left:second.left,top:second.top}})()`,
    );
    assert.ok(
      Math.abs(delta.x) > 5,
      'The join starts separated and requires a real drag',
    );
    await run('projectHistory.holdNextCanvas();void 0');
    const gesture = await drag(second, delta.x, delta.y);
    assert.ok(
      gesture.drop.status.some((message) => message.startsWith('松开拼接')),
      'A real snap preview existed before mouse-up',
    );
    await wait(
      'projectHistory.state().canvasPending',
      'video commit receipt is genuinely delayed after release',
    );
    await paint();
    const waiting = await run(
      `(()=>{const e=document.querySelector(${JSON.stringify(`${main} [data-video-card="${cardB}"]`)});if(!e)throw Error('Moving card vanished before receipt');const r=e.getBoundingClientRect();return {left:r.left,top:r.top,count:document.querySelectorAll(${JSON.stringify(`${main} [data-video-card]`)}).length,busy:document.querySelector(${JSON.stringify(main)}).getAttribute('aria-busy')}})()`,
    );
    assert.equal(
      waiting.count,
      2,
      'Presentation does not prematurely adopt the unreceived snapshot',
    );
    assert.equal(waiting.busy, 'true');
    assert.deepEqual(
      { left: waiting.left, top: waiting.top },
      { left: gesture.drop.screen.left, top: gesture.drop.screen.top },
      'Mouse-up keeps the moving card at its drop position while save is pending',
    );
    assert.ok(
      Math.abs(waiting.left - delta.left) > 5,
      'The pending card must not jump back to the drag origin',
    );
    assert.equal(
      (await state()).remote.canvas.cards.length,
      1,
      'Native storage has already committed; only the receipt is delayed',
    );
    await run('projectHistory.releaseCanvas();void 0');
    // Read the DOM as well as persistence; no hidden hook method creates the join.
    await wait(
      `document.querySelectorAll(${JSON.stringify(`${main} [data-video-card]`)}).length===1&&projectHistory.state().remote.canvas.cards.length===1`,
      'native drag joins two videos',
    );
    assert.deepEqual((await state()).remote.canvas.cards[0].assetIds, [a, b]);
  };

  await load();
  assert.equal(await enabled('撤销'), false);
  await click(
    `${main} [data-video-card="${cardB}"] button[aria-label="编辑镜头素材"]`,
  );
  await wait(
    `!!document.querySelector(${JSON.stringify(page)})`,
    'video-associated material page',
  );
  await back();
  await count(3);
  const linked = (await state()).stored.shots.find(
    (shot) => shot.sourceAssetId === b,
  );
  assert.ok(linked);
  assert.equal(
    await run(
      `!!document.querySelector(${JSON.stringify(h.shotSelector(linked.id))})`,
    ),
    false,
  );
  assert.equal(
    await enabled('撤销'),
    false,
    'Opening the initial video-associated shot creates no main-history edit',
  );
  assert.equal(
    await run(
      `!!document.querySelector(${JSON.stringify(`${main} button[aria-label="移除镜头"]`)})`,
    ),
    false,
  );
  console.log(
    'PASS project history: opening video materials preserves source association and does not add a standalone card or a main undo entry',
  );

  await load();
  await button('新建镜头', main);
  await wait(
    `!!document.querySelector(${JSON.stringify(page)})`,
    'new shot opens',
  );
  await button('文本');
  await wait(
    `document.querySelectorAll(${JSON.stringify(`${page} textarea`)}).length===1`,
    'new text card',
  );
  await input(`${page} textarea`, '新建后编辑的完整内容');
  await rename('新建镜头最终名称', false);
  await back();
  await count(3);
  let s = await state();
  const created = s.stored.shots.find(
    (shot) => !s.initialWorkspace.shots.some((old) => old.id === shot.id),
  );
  assert.equal(created.name, '新建镜头最终名称');
  assert.equal(created.nodes[0].text, '新建后编辑的完整内容');
  await mainHistory('撤销');
  await count(2);
  assert.deepEqual((await state()).stored.shots, s.initialWorkspace.shots);
  await mainHistory('重做');
  await count(3);
  assert.deepEqual(
    (await state()).stored.shots.find((shot) => shot.id === created.id),
    created,
  );
  assert.deepEqual((await state()).remote.canvas, s.initialSnapshot.canvas);
  await assertBaselineProtected();
  console.log(
    'PASS project history: create, native text/name input and return save before main undo; redo restores the latest edited shot rather than an empty creation snapshot',
  );

  await load();
  await openShot('seed-shot');
  await rename('源镜头独立改名');
  await button('复制镜头');
  await count(3);
  await wait(
    `document.querySelector(${JSON.stringify(page)})?.getAttribute('aria-label')==='源镜头独立改名 副本素材子画布'`,
    'saved copy opens',
  );
  s = await state();
  const source = s.stored.shots.find((shot) => shot.id === 'seed-shot');
  const copy = s.stored.shots.find(
    (shot) => !s.initialWorkspace.shots.some((old) => old.id === shot.id),
  );
  assert.deepEqual(shape(copy), shape(source));
  assert.equal(Object.hasOwn(copy, 'sourceAssetId'), false);
  const ids = (shot) => [
    shot.id,
    ...shot.nodes.map((node) => node.id),
    ...shot.groups.map((group) => group.id),
    ...(shot.labels ?? []).map((label) => label.id),
  ];
  const originalIds = new Set(ids(source));
  assert.ok(ids(copy).every((id) => !originalIds.has(id)));
  await input(text(page, copy.nodes[0].id), '副本后续独立内容');
  await click(`${page} button[aria-label="撤销"]`);
  await wait(
    `document.querySelector(${JSON.stringify(text(page, copy.nodes[0].id))})?.value==='原始独立正文'`,
    'copy local undo',
  );
  await click(`${page} button[aria-label="重做"]`);
  await back();
  await savedText(copy.id, '副本后续独立内容');
  const editedCopy = (await state()).stored.shots.find(
    (shot) => shot.id === copy.id,
  );
  assert.deepEqual(
    (await state()).stored.shots.find((shot) => shot.id === 'seed-shot'),
    source,
  );
  await mainHistory('撤销');
  await count(2);
  await openShot('seed-shot');
  await click(`${page} button[aria-label="撤销"]`);
  await wait(
    `document.querySelector(${JSON.stringify(page)})?.getAttribute('aria-label')==='已存独立镜头素材子画布'`,
    'source keeps its independent name undo',
  );
  await back();
  assert.equal(
    await enabled('重做'),
    true,
    'Child content undo does not clear main redo',
  );
  await mainHistory('重做');
  await count(3);
  assert.deepEqual(
    (await state()).stored.shots.find((shot) => shot.id === copy.id),
    editedCopy,
  );
  assert.deepEqual(
    content(
      (await state()).stored.shots.find((shot) => shot.id === 'seed-shot'),
    ),
    content(s.initialWorkspace.shots[0]),
  );
  await assertBaselineProtected();
  console.log(
    'PASS project history: copy remaps identities but preserves groups/references; source and copy child histories remain independent while main copy redo survives child undo',
  );

  await load();
  const original = (await state()).stored.shots[0];
  const movedGesture = await drag(
    `${h.shotSelector('seed-shot')} article > div`,
    90,
    45,
  );
  await wait(
    'projectHistory.state().stored.shots[0].position.x!==100',
    'shot drag saved',
  );
  const moved = (await state()).stored.shots[0].position;
  assert.deepEqual(movedGesture.before.position, original.position);
  assert.deepEqual(
    moved,
    movedGesture.drop.position,
    'Saved canvas coordinates exactly match the observed node position before mouse-up',
  );
  assert.deepEqual(
    movedGesture.drop.camera,
    movedGesture.before.camera,
    'This center-screen gesture does not change pan or zoom',
  );
  assert.ok(moved.x > original.position.x && moved.y > original.position.y);
  await openShot('seed-shot');
  await input(text(page, 'solo-text'), '移动后继续编辑正文');
  await back();
  const edited = (await state()).stored.shots[0];
  await mainHistory('撤销');
  await wait(
    'projectHistory.state().stored.shots[0].position.x===100',
    'move undo saved',
  );
  assert.deepEqual(content((await state()).stored.shots[0]), content(edited));
  assert.deepEqual((await state()).stored.shots[0].position, original.position);
  await mainHistory('重做');
  await wait(
    `projectHistory.state().stored.shots[0].position.x===${moved.x}`,
    'move redo saved',
  );
  assert.deepEqual(
    (await state()).stored.shots[0].position,
    movedGesture.drop.position,
  );
  await remove('seed-shot');
  await count(1);
  await mainHistory('撤销');
  await count(2);
  assert.deepEqual((await state()).stored.shots[0], edited);
  await openShot('seed-shot');
  await input(text(page, 'solo-text'), '恢复镜头后再次修改');
  await back();
  const latest = (await state()).stored.shots[0];
  assert.equal(await enabled('重做'), true);
  await mainHistory('重做');
  await count(1);
  await mainHistory('撤销');
  await count(2);
  assert.deepEqual((await state()).stored.shots[0], latest);
  await assertBaselineProtected();
  console.log(
    'PASS project history: real shot drag undo changes position only; remove/restore and later redo retain the latest text, parameters, labels and references',
  );

  await load();
  const beforeMixed = await state();
  await join();
  const joined = structuredClone((await state()).remote.canvas.cards);
  await remove('seed-shot');
  await count(1);
  await reveal(`${main} [data-video-card] [data-asset-id="${b}"]`);
  await click(`${main} [data-video-card] [data-asset-id="${b}"]`);
  await button('拆分选中片段', `${main} fieldset[aria-label="画布操作"]`);
  await wait(
    'projectHistory.state().remote.canvas.cards.length===2',
    'selected fragment split',
  );
  const split = structuredClone((await state()).remote.canvas.cards);
  assert.deepEqual(
    split.flatMap((card) => card.assetIds),
    [a, b],
  );
  const trims = Object.assign({}, ...split.map((card) => card.trims));
  assert.deepEqual(
    trims,
    Object.assign(
      {},
      ...beforeMixed.remote.canvas.cards.map((card) => card.trims),
    ),
  );
  await mainHistory('撤销');
  await wait(
    'projectHistory.state().remote.canvas.cards.length===1',
    'undo split first',
  );
  assert.deepEqual((await state()).remote.canvas.cards, joined);
  assert.equal((await state()).stored.shots.length, 1);
  await mainHistory('撤销');
  await count(2);
  assert.deepEqual((await state()).stored.shots, beforeMixed.stored.shots);
  assert.deepEqual((await state()).remote.canvas.cards, joined);
  await mainHistory('撤销');
  await wait(
    'projectHistory.state().remote.canvas.cards.length===2',
    'undo join last',
  );
  assert.deepEqual(
    cardSet((await state()).remote.canvas.cards),
    cardSet(beforeMixed.remote.canvas.cards),
  );
  assert.equal(await enabled('撤销'), false);
  await mainHistory('重做');
  await wait(
    'projectHistory.state().remote.canvas.cards.length===1',
    'redo join',
  );
  await mainHistory('重做');
  await count(1);
  await mainHistory('重做');
  await wait(
    'projectHistory.state().remote.canvas.cards.length===2',
    'redo split',
  );
  assert.deepEqual((await state()).remote.canvas.cards, split);
  await assertBaselineProtected();
  console.log(
    'PASS project history: delayed join receipt keeps the dropped presentation; video snap-join, shot removal and selected-fragment split share chronological undo/redo without changing source association, order or trim',
  );

  await load();
  await run("projectHistory.fault('reject');projectHistory.holdNext();void 0");
  await remove('seed-shot');
  await wait('projectHistory.state().pending', 'staged removal write pending');
  assert.equal(
    await run(
      `!!document.querySelector(${JSON.stringify(`${main} section[aria-label="镜头恢复草稿"]`)})`,
    ),
    false,
    'An ordinary pending list save is not a recovery failure and shows no rescue banner',
  );
  assert.equal((await state()).stored.shots.length, 2);
  assert.equal(await enabled('撤销'), false);
  assert.equal(await enabled('重做'), false);
  assert.equal(
    await run(
      `([...document.querySelectorAll(${JSON.stringify(`${main} button`)})].find(e=>e.textContent.trim()==='新建镜头')).disabled`,
    ),
    true,
  );
  await run('projectHistory.release();void 0');
  await wait(
    `!!document.querySelector(${JSON.stringify(`${main} button[aria-label="重试镜头数据"]`)})`,
    'failed shot write offers retry',
  );
  assert.equal(
    await run(
      `!!document.querySelector(${JSON.stringify(`${main} section[aria-label="镜头恢复草稿"]`)})`,
    ),
    true,
    'A real save failure retains the current rescue export beside its usable retry',
  );
  assert.equal((await state()).stored.shots.length, 2);
  const staged = (await state()).saves[0].input;
  await run("projectHistory.fault('none');void 0");
  await click(`${main} button[aria-label="重试镜头数据"]`);
  await count(1);
  const removalAttempts = (await state()).saves;
  assert.equal(
    removalAttempts.filter((attempt) => attempt.committed).length,
    1,
  );
  assert.ok(
    removalAttempts.every(
      (attempt) => JSON.stringify(attempt.input) === JSON.stringify(staged),
    ),
  );
  await mainHistory('撤销');
  await count(2);
  assert.equal(await enabled('撤销'), false, 'Retry records the removal once');
  await run('projectHistory.rejectCanvas(true);void 0');
  await drag(`${main} [data-video-card="${cardB}"] footer > span`, 70, 40);
  await wait(
    "projectHistory.state().reports.some(e=>e.includes('视频保存失败'))",
    'video failure observed',
  );
  assert.deepEqual(
    (await state()).remote.canvas,
    (await state()).initialSnapshot.canvas,
  );
  assert.equal(await enabled('撤销'), false);
  assert.equal(
    await enabled('重做'),
    true,
    'Failed video edit preserves the preceding redo branch',
  );
  await run('projectHistory.rejectCanvas(false);void 0');
  await drag(`${main} [data-video-card="${cardB}"] footer > span`, 70, 40);
  await wait(
    'projectHistory.state().remote.canvas.revision===1',
    'retry video drag saved',
  );
  await mainHistory('撤销');
  await wait(
    'projectHistory.state().remote.canvas.revision===2',
    'single video undo',
  );
  assert.deepEqual(
    cardSet((await state()).remote.canvas.cards),
    cardSet((await state()).initialSnapshot.canvas.cards),
  );
  assert.equal(await enabled('撤销'), false);
  console.log(
    'PASS project history: staged failed shot removal stays busy until retry and records once; a rejected video edit neither advances history nor destroys redo',
  );

  await load();
  await openShot('seed-shot');
  await run('projectHistory.holdNext();void 0');
  await input(text(page, 'solo-text'), '在途保存 A');
  await wait(
    'projectHistory.state().pending',
    'A genuinely reached the save boundary',
  );
  await input(text(page, 'solo-text'), '在途之后输入 B');
  await button('返回主画布');
  await wait(
    `document.querySelector(${JSON.stringify(page)})?.inert===true`,
    'return waits for both input versions',
  );
  assert.equal((await state()).stored.shots[0].nodes[0].text, '原始独立正文');
  await run('projectHistory.release();void 0');
  await wait(
    `!document.querySelector(${JSON.stringify(page)})`,
    'return after A and B saved',
  );
  await savedText('seed-shot', '在途之后输入 B');
  const incoming = (await state()).saves
    .filter((attempt) => attempt.committed)
    .map((attempt) => attempt.input.shots[0].nodes[0].text);
  assert.deepEqual(incoming, ['在途保存 A', '在途之后输入 B']);
  const settled = (await state()).stored.shots[0];
  await remove('seed-shot');
  await count(1);
  await mainHistory('撤销');
  await count(2);
  assert.deepEqual((await state()).stored.shots[0], settled);
  await assertBaselineProtected();
  console.log(
    'PASS project history: input B during deferred save A is flushed before return; removal and undo retain B without a late save resurrecting an older shot',
  );

  await load();
  const readCount = (await state()).reads;
  await run("projectHistory.fault('lost-exact');void 0");
  await remove('seed-shot');
  await count(1);
  await wait(
    `projectHistory.state().reads>${readCount}`,
    'lost reply performs strict reread',
  );
  await wait(
    `document.querySelector(${JSON.stringify(`${main} fieldset[aria-label="画布操作"] button[aria-label="撤销"]`)})?.disabled===false`,
    'exact receipt accepted as success',
  );
  assert.equal((await state()).saves.length, 1);
  assert.equal((await state()).saves[0].committed, true);
  assert.equal(
    await run(
      `!!document.querySelector(${JSON.stringify(`${main} button[aria-label="重试镜头数据"]`)})`,
    ),
    false,
  );
  await mainHistory('撤销');
  await count(2);
  assert.equal(await enabled('撤销'), false);
  await mainHistory('重做');
  await count(1);
  assert.equal((await state()).saves.length, 3);
  console.log(
    'PASS project history: a real isolated commit followed by a lost reply is recognized only by exact payload/revision reread and contributes one undo entry',
  );

  await load();
  await run("projectHistory.fault('lost-read-failure');void 0");
  await remove('seed-shot');
  await wait(
    'projectHistory.state().unavailable&&projectHistory.state().readFailures===0',
    'failed receipt and first reread report the project as unavailable',
  );
  await paint();
  const failureLayout = await run(`(()=>{
    const retry=document.querySelector(${JSON.stringify(`${main} button[aria-label="重试镜头数据"]`)}),notice=document.querySelector(${JSON.stringify(`${main} section[aria-label="镜头恢复草稿"]`)}),error=retry?.closest('[role="alert"]');
    if(!retry||!notice||!error)throw Error('Expected both save failure and recovery notice');
    const r=retry.getBoundingClientRect(),n=notice.getBoundingClientRect(),e=error.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2,hit=document.elementFromPoint(x,y);
    return {disabled:retry.disabled,pointerEvents:getComputedStyle(retry).pointerEvents,buttonContainsHit:retry.contains(hit),errorContainsHit:error.contains(hit),noticeContainsHit:notice.contains(hit),errorHeight:e.height,noticeHeight:n.height,errorBottom:e.bottom,noticeTop:n.top,centerInViewport:x>=0&&x<innerWidth&&y>=0&&y<innerHeight};
  })()`);
  assert.equal(
    failureLayout.disabled,
    true,
    'An unavailable project does not enable a retry write',
  );
  assert.ok(failureLayout.errorHeight > 0 && failureLayout.noticeHeight > 0);
  assert.ok(
    failureLayout.noticeTop >= failureLayout.errorBottom,
    'Save error and recovery notice occupy separate vertical rows',
  );
  assert.equal(failureLayout.centerInViewport, true);
  assert.equal(
    failureLayout.noticeContainsHit,
    false,
    'The recovery notice cannot obscure the retry center',
  );
  if (failureLayout.pointerEvents === 'none') {
    assert.equal(
      failureLayout.errorContainsHit,
      true,
      'Disabled buttons intentionally pass hit testing to their own save-error row',
    );
  } else {
    assert.equal(failureLayout.buttonContainsHit, true);
  }
  assert.equal((await state()).stored.shots.length, 1);
  assert.equal((await state()).saves.length, 1);
  assert.equal(
    await run(
      `document.querySelector(${JSON.stringify(main)}).getAttribute('aria-busy')`,
    ),
    'true',
    'Unconfirmed submission retains its main-history ticket',
  );
  assert.equal(await enabled('撤销'), false);
  assert.equal(await enabled('重做'), false);
  const rejected = await run('projectHistory.verify(true)');
  assert.equal(rejected, '另一个编辑器仍有未确认内容（验收注入）');
  await paint();
  assert.equal(
    (await state()).unavailable,
    true,
    'This editor confirming its own write cannot release the outer project lock',
  );
  assert.equal(
    (await state()).saves.length,
    1,
    'Recovery uses read evidence and does not repeat the committed write',
  );
  assert.equal(
    await run(
      `document.querySelector(${JSON.stringify(main)}).getAttribute('aria-busy')`,
    ),
    'false',
    'The proven submission settles once even when another guard refuses to resume',
  );
  assert.equal(await enabled('撤销'), false);
  assert.equal(
    await run(
      `([...document.querySelectorAll(${JSON.stringify(`${main} button`)})].find(e=>e.textContent.trim()==='新建镜头')).disabled`,
    ),
    true,
  );
  assert.equal(await run('projectHistory.verify(false)'), null);
  await wait(
    '!projectHistory.state().unavailable',
    'all project recovery guards permit resume',
  );
  await paint();
  assert.equal((await state()).saves.length, 1);
  assert.deepEqual((await state()).recoveries, [rejected, null]);
  await mainHistory('撤销');
  await count(2);
  assert.deepEqual(
    (await state()).stored.shots,
    (await state()).initialWorkspace.shots,
  );
  assert.equal(
    (await state()).saves.length,
    2,
    'Only the explicit undo issues a second write',
  );
  assert.equal(
    await enabled('撤销'),
    false,
    'Recovery and repeated verification do not duplicate history entries',
  );
  await assertBaselineProtected();
  console.log(
    'PASS project history: lost receipt plus failed first reread blocks the project; exact recovery confirms once without rewriting, another guard keeps it blocked, and full resume permits one undo',
  );

  for (const fault of ['lost-different', 'lost-revision']) {
    await load();
    await run(`projectHistory.fault(${JSON.stringify(fault)});void 0`);
    await remove('seed-shot');
    await wait(
      `!!document.querySelector(${JSON.stringify(`${main} button[aria-label="重试镜头数据"]`)})`,
      `${fault} stays unresolved`,
    );
    const conflicted = await state();
    assert.equal(
      conflicted.saves.filter((attempt) => attempt.committed).length,
      1,
    );
    assert.equal(await enabled('撤销'), false);
    assert.equal(await enabled('重做'), false);
    await click(`${main} button[aria-label="重试镜头数据"]`);
    await wait(
      `projectHistory.state().reads>${conflicted.reads}`,
      'explicit retry checks the previous uncertain submission',
    );
    await wait(
      "projectHistory.state().reports.some(e=>e.includes('未覆盖其他版本'))",
      'retry cannot adopt foreign revision',
    );
    const after = await state();
    assert.deepEqual(after.stored, conflicted.stored);
    assert.equal(
      after.saves.length,
      conflicted.saves.length,
      'A mismatched retry is rejected before another write',
    );
    assert.equal(after.saves.filter((attempt) => attempt.committed).length, 1);
    assert.ok(after.saves.every((attempt) => attempt.input.revision === 0));
    assert.equal(await enabled('撤销'), false);
    await assertBaselineProtectedUnlessChanged(fault, after);
  }
  console.log(
    'PASS project history: same-revision different content and same-content wrong revision are both retained as conflicts; retry never adopts a foreign baseline or overwrites it',
  );
}

function assertBaselineProtectedUnlessChanged(fault, state) {
  assert.deepEqual(state.remote.assets, state.initialSnapshot.assets);
  assert.deepEqual(state.remote.canvas, state.initialSnapshot.canvas);
  const remaining = state.stored.shots[0];
  const expected = structuredClone(state.initialWorkspace.shots[1]);
  if (fault === 'lost-different') expected.name = '外部提交的不同内容';
  assert.deepEqual(remaining, expected);
}
module.exports = { runCases };
