// Historical business modules must come only from the fixed Git archive.
// The unchanged image-workspace writer creates the real projects and media first.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [source, directory, writerCommit, mode] = process.argv.slice(2);
assert.ok(source && directory);
assert.match(writerCommit, /^[a-f0-9]{40}$/);
assert.ok(['unsubmitted', 'last-submitted'].includes(mode));
const { Library } = await import(
  pathToFileURL(join(source, 'src/main/storage/library.ts')).href
);
const { WorkspaceDraftService } = await import(
  pathToFileURL(join(source, 'src/main/drafts/workspace-draft-service.ts')).href
);
const expected = JSON.parse(
  await readFile(join(directory, 'expected.json'), 'utf8'),
);
assert.equal(expected.mode, 'image-workspace');
const [original, independent] = expected.projects;
assert.ok(original && independent && expected.workspace);
const hash = async (file) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const library = await Library.open(join(directory, 'app'), expected.root);
try {
  assert.ok(library.drafts instanceof WorkspaceDraftService);
  await library.saves.idle();
  assert.deepEqual(await library.projects.open(original.project.id), original);
  assert.deepEqual(
    await library.generation.readWorkspace(original.project.id),
    expected.workspace,
  );
  const baseline = structuredClone(expected.workspace);
  const sessionId = `historical-${mode}`;
  let diskWorkspace = baseline;
  let lastSubmitted;
  let current = structuredClone(baseline);
  if (mode === 'last-submitted') {
    const text = current.shots[0].nodes.find((node) => node.id === 'text-two');
    assert.equal(text.type, 'text');
    text.text += '\n提交 A 已入项目，但旧窗口尚未收到回执 📨';
    lastSubmitted = {
      ...structuredClone(current),
      revision: baseline.revision + 1,
    };
    await library.drafts.protect(original.project, {
      sessionId,
      seq: 1,
      baseline,
      workspace: current,
      lastSubmitted,
    });
    // The old service really commits A. Deliberately do not acknowledge its draft.
    assert.deepEqual(
      await library.generation.saveWorkspace(original.project.id, current),
      lastSubmitted,
    );
    diskWorkspace = lastSubmitted;
    current = structuredClone(current);
  }

  // Author the desired content before invoking either writer. Never derive the
  // expected workspace from a response that could already have lost its fields.
  const shot = current.shots[0];
  const text = shot.nodes.find((node) => node.id === 'text-two');
  assert.equal(text.type, 'text');
  text.text += `\n未保存的 ${mode} 草稿 B：保留中文、换行和 emoji 🎬`;
  const override = shot.nodes.find((node) => node.id === 'reference-2');
  assert.equal(override.type, 'asset');
  override.textOverride += '\n草稿中的源文本覆盖，不能改写原文件';
  const video = shot.groups.find((group) => group.id === 'group-one');
  video.parameters = {
    ...video.parameters,
    ratio: '1:1',
    duration: 8,
    generateAudio: true,
  };
  const image = shot.groups.find((group) => group.id === 'image-text-group');
  assert.equal(image.kind, 'image');
  image.parameters.resolution = '4K';
  shot.position.x += 23.5;
  shot.viewport = { x: -120, y: 60, zoom: 0.75 };
  shot.labels[0].name += '（恢复草稿）';
  [shot.nodes[0], shot.nodes[1]] = [shot.nodes[1], shot.nodes[0]];
  const secondShot = current.shots[1];
  secondShot.nodes.push({
    id: 'draft-only-text',
    type: 'text',
    text: '仅在恢复草稿中的第二镜头文本',
    position: { x: 20, y: 40 },
    groupId: 'draft-only-group',
  });
  secondShot.groups.push({
    id: 'draft-only-group',
    kind: 'video',
    position: { x: 150, y: 240 },
    width: 760,
    height: 340,
    parameters: { ...video.parameters, duration: 6 },
  });
  const input = {
    sessionId,
    seq: mode === 'last-submitted' ? 2 : 1,
    baseline,
    workspace: current,
    ...(lastSubmitted ? { lastSubmitted } : {}),
  };
  assert.equal(
    await library.drafts.protect(original.project, input),
    input.seq,
  );
  const found = await library.drafts.list(original.project.id);
  assert.deepEqual(found.issues, []);
  assert.equal(found.drafts.length, 1);
  const record = found.drafts[0];
  assert.ok(Number.isFinite(Date.parse(record.updatedAt)));
  assert.deepEqual(record, {
    ...input,
    format: 'infinite-afflatus-workspace-draft',
    version: 1,
    project: {
      id: original.project.id,
      folder: original.project.folder,
      name: original.project.name,
    },
    updatedAt: record.updatedAt,
    saved: false,
  });
  assert.deepEqual(
    await library.generation.readWorkspace(original.project.id),
    diskWorkspace,
  );
  const file = join(
    directory,
    'app',
    'workspace-drafts',
    `${original.project.id}.${sessionId}.json`,
  );
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), record);
  const unrelatedFile = join(
    directory,
    'app',
    'workspace-drafts',
    '用户说明.txt',
  );
  const unrelatedContent = '保留这份恢复目录中的用户文件，不属于草稿清理';
  await writeFile(unrelatedFile, unrelatedContent);
  const independentFile = join(
    expected.root,
    independent.project.folder,
    'project.sqlite',
  );
  await writeFile(
    join(directory, 'workspace-draft-expected.json'),
    JSON.stringify(
      {
        writerCommit,
        formatVersion: 1,
        mode,
        record,
        diskWorkspace,
        file,
        fileSha256: await hash(file),
        unrelatedFile,
        unrelatedContent,
        independentFile,
        independentSha256: await hash(independentFile),
      },
      null,
      2,
    ),
  );
} finally {
  await library.close();
}
