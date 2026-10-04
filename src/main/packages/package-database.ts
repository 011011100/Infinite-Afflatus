import { backup } from 'node:sqlite';
import { validateGenerationDraft } from '../../shared/generation/draft';
import { imageInputError } from '../../shared/generation/image-generation';
import {
  validateWorkspace,
  workspaceFromDraft,
} from '../../shared/generation/workspace';
import type { Asset, ProjectSummary } from '../../shared/models';
import {
  readProject,
  verifyProjectDatabase,
  withProject,
} from '../projects/project-database';
import {
  isId,
  validateName,
  validateViewport,
} from '../projects/project-service';
import { openDatabase } from '../storage/database';
import {
  MAX_FILES,
  type PackageEntry,
  type PackageManifest,
  validatePackagePath,
} from './package-format';

const KEYS = new Set([
  'project',
  'viewport',
  'canvas',
  'generation-draft',
  'generation-workspace',
  'proxies',
]);

/** Check an untrusted database before any writes, including triggers and reference integrity. */
export function validatePackageDatabase(
  file: string,
  manifest?: PackageManifest,
) {
  verifyProjectDatabase(file);
  withProject(file, false, (db) => {
    const schema = db
      .prepare(
        "SELECT name, type FROM sqlite_schema WHERE substr(name, 1, 7) <> 'sqlite_'",
      )
      .all();
    if (
      schema.length !== 2 ||
      schema.some(
        (row) =>
          row.type !== 'table' ||
          !['metadata', 'assets'].includes(String(row.name)),
      )
    )
      throw new Error('项目数据库包含不支持的表、视图或触发器');
    for (const [table, expected] of [
      [
        'metadata',
        [
          { name: 'key', pk: 1, notnull: 0 },
          { name: 'value', pk: 0, notnull: 1 },
        ],
      ],
      [
        'assets',
        [
          { name: 'id', pk: 1, notnull: 0 },
          { name: 'result_key', pk: 0, notnull: 1 },
          { name: 'payload', pk: 0, notnull: 1 },
        ],
      ],
    ] as const) {
      const columns = db.prepare(`PRAGMA table_xinfo(${table})`).all();
      if (
        columns.length !== expected.length ||
        columns.some(
          (column, index) =>
            column.name !== expected[index]?.name ||
            String(column.type).toUpperCase() !== 'TEXT' ||
            column.hidden !== 0 ||
            column.pk !== expected[index]?.pk ||
            column.notnull !== expected[index]?.notnull,
        )
      )
        throw new Error('项目数据库表结构不受支持');
      const indices = db
        .prepare(
          'SELECT name, "unique", origin, partial FROM pragma_index_list(?)',
        )
        .all(table);
      const constraints =
        table === 'metadata'
          ? [{ column: 'key', origin: 'pk' }]
          : [
              { column: 'id', origin: 'pk' },
              { column: 'result_key', origin: 'u' },
            ];
      if (
        indices.length !== constraints.length ||
        constraints.some(
          (constraint) =>
            !indices.some((index) => {
              if (
                index.unique !== 1 ||
                index.partial !== 0 ||
                index.origin !== constraint.origin
              )
                return false;
              const fields = db
                .prepare('SELECT name FROM pragma_index_info(?)')
                .all(String(index.name));
              return (
                fields.length === 1 && fields[0]?.name === constraint.column
              );
            }),
        )
      )
        throw new Error('项目数据库缺少必须的主键或唯一约束');
    }
    if (
      db
        .prepare(
          'SELECT 1 FROM metadata WHERE key IS NULL OR value IS NULL LIMIT 1',
        )
        .get() ||
      db
        .prepare(
          'SELECT key FROM metadata GROUP BY key HAVING COUNT(*) > 1 LIMIT 1',
        )
        .get()
    )
      throw new Error('项目元数据包含空值或重复记录');
    for (const column of ['id', 'result_key']) {
      if (
        db
          .prepare(
            `SELECT ${column} FROM assets GROUP BY ${column} HAVING COUNT(*) > 1 LIMIT 1`,
          )
          .get()
      )
        throw new Error('项目素材索引包含重复记录');
    }
    const count = Number(
      db.prepare('SELECT COUNT(*) AS count FROM assets').get()?.count,
    );
    if (count > MAX_FILES - 1) throw new Error('项目素材数量超出支持范围');
    if (
      db
        .prepare('SELECT 1 FROM assets WHERE length(payload) > 16384 LIMIT 1')
        .get()
    )
      throw new Error('项目素材记录体积无效');
    const metadata = db
      .prepare('SELECT key, length(value) AS size FROM metadata')
      .all();
    if (
      metadata.some(
        (row) =>
          !KEYS.has(String(row.key)) || Number(row.size) > 16 * 1024 * 1024,
      )
    )
      throw new Error('项目包含不受支持的数据，不能制作可移植项目包');
  });
  const snapshot = readProject(file);
  if (
    !isId(snapshot.project.id) ||
    snapshot.project.folder !== snapshot.project.id
  )
    throw new Error('项目标识无效');
  validateName(snapshot.project.name);
  validateViewport(snapshot.viewport);
  const ids = new Set<string>();
  const paths = new Set<string>();
  const entries: PackageEntry[] = snapshot.assets.map((asset: Asset) => {
    if (
      !asset ||
      !isId(asset.id) ||
      ids.has(asset.id) ||
      !['video', 'image', 'audio', 'text'].includes(asset.kind) ||
      (asset.usage !== undefined && asset.usage !== 'reference') ||
      typeof asset.name !== 'string' ||
      !asset.name.length ||
      asset.name.length > 1000 ||
      !Number.isSafeInteger(asset.size) ||
      asset.size < 0 ||
      typeof asset.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(asset.sha256)
    )
      throw new Error('项目素材记录无效');
    validatePackagePath(asset.relativePath);
    if (
      !asset.relativePath.startsWith('assets/') ||
      paths.has(asset.relativePath.toLowerCase())
    )
      throw new Error('项目素材路径重复或无效');
    ids.add(asset.id);
    paths.add(asset.relativePath.toLowerCase());
    return {
      type: 'file',
      path: asset.relativePath,
      size: asset.size,
      sha256: asset.sha256,
    };
  });
  withProject(file, false, (db) => {
    for (const row of db
      .prepare('SELECT id, result_key, payload FROM assets')
      .all()) {
      const asset = JSON.parse(String(row.payload)) as Asset;
      if (
        row.id !== asset.id ||
        typeof row.result_key !== 'string' ||
        !row.result_key.length
      )
        throw new Error('项目素材索引与记录不一致');
    }
    const requireReference = (id: string) => {
      if (!ids.has(id))
        throw new Error('项目仍有未保存或缺失的素材引用，请等待保存完成后重试');
    };
    const draft = db
      .prepare("SELECT value FROM metadata WHERE key = 'generation-draft'")
      .get();
    if (draft)
      validateGenerationDraft(
        JSON.parse(String(draft.value)),
      ).referenceIds.forEach(requireReference);
    const row = db
      .prepare("SELECT value FROM metadata WHERE key = 'generation-workspace'")
      .get();
    if (row) {
      const workspace = validateWorkspace(JSON.parse(String(row.value)));
      for (const shot of workspace.shots) {
        if (shot.sourceAssetId) {
          requireReference(shot.sourceAssetId);
          if (
            !snapshot.assets.some(
              (asset) =>
                asset.id === shot.sourceAssetId && asset.kind === 'video',
            )
          )
            throw new Error('镜头引用不是视频素材');
        }
        for (const node of shot.nodes)
          if (node.type === 'asset') requireReference(node.assetId);
        for (const group of shot.groups) {
          if (group.kind !== 'image') continue;
          const error = imageInputError(
            shot.nodes.filter((node) => node.groupId === group.id),
            snapshot.assets,
          );
          if (error) throw new Error(error);
        }
      }
    }
  });
  if (manifest) {
    const files = new Map(manifest.entries.map((entry) => [entry.path, entry]));
    if (
      files.size !== entries.length + 1 ||
      entries.some((entry) => {
        const listed = files.get(entry.path);
        return (
          !listed ||
          listed.size !== entry.size ||
          listed.sha256 !== entry.sha256
        );
      })
    )
      throw new Error('项目数据库与素材清单不一致');
  }
  return { snapshot, entries };
}

export async function snapshotPackageDatabase(
  source: string,
  destination: string,
): Promise<void> {
  const db = openDatabase(source, true);
  try {
    await backup(db, destination);
  } finally {
    db.close();
  }
  validatePackageDatabase(destination);
  const copy = openDatabase(destination);
  try {
    // Only the disposable backup is changed. VACUUM removes excluded cache records from free pages.
    copy.exec(
      "PRAGMA secure_delete = ON; DELETE FROM metadata WHERE key = 'proxies'; VACUUM;",
    );
  } finally {
    copy.close();
  }
}

export function adoptPackageDatabase(file: string, project: ProjectSummary) {
  withProject(file, true, (db) => {
    const put = db.prepare('INSERT OR REPLACE INTO metadata VALUES (?, ?)');
    // Freeze legacy-derived internal IDs before assigning a new outer project identity.
    if (
      !db
        .prepare("SELECT 1 FROM metadata WHERE key = 'generation-workspace'")
        .get()
    ) {
      const old = JSON.parse(
        String(
          db.prepare("SELECT value FROM metadata WHERE key = 'project'").get()
            ?.value,
        ),
      ) as ProjectSummary;
      const legacy = db
        .prepare("SELECT value FROM metadata WHERE key = 'generation-draft'")
        .get();
      if (legacy) {
        const draft = validateGenerationDraft(JSON.parse(String(legacy.value)));
        put.run(
          'generation-workspace',
          JSON.stringify(workspaceFromDraft(old.id, draft)),
        );
      }
    }
    db.prepare("DELETE FROM metadata WHERE key = 'proxies'").run();
    put.run('project', JSON.stringify(project));
  });
  return readProject(file);
}
