import { createHash, randomUUID } from 'node:crypto';
import { isAbsolute, join } from 'node:path';
import type { MigrationPreview } from '../../shared/models';
import type { MigrationJournal } from '../migration/manifest';
import {
  RELOCATION_DIRECTORY,
  RELOCATION_FILE,
} from '../relocation/root-relocation-types';
import type { AppStore } from '../storage/app-store';
import { fingerprint, safeFile, sameContent } from '../storage/files';
import { verifyCutover } from './backup-cutover';
import {
  ANCHOR_FILE,
  BACKUP_DIRECTORY,
  type DirectoryIdentity,
  directoryIdentity,
  info,
  RESTORE_FILE,
  RETAINED_DIRECTORY,
  readJson,
  sameIdentity,
  UUID,
  validIdentity,
  verifyDirectory,
  writeJson,
} from './backup-files';

export const GENERATION_KEY = 'appBackupGeneration';
type SourceEvidence = ReturnType<AppStore['backupSourceEvidence']>;
export interface BackupAnchor {
  format: 'infinite-afflatus-app-backup-anchor';
  version: 1;
  profileId: string;
  generation: string;
  userData: DirectoryIdentity;
  root: DirectoryIdentity;
  initializing: SourceEvidence | null;
  migration: {
    id: string;
    target: DirectoryIdentity;
    phase: 'prepared' | 'active' | 'switching' | 'target';
    priorJournal: string;
    priorGeneration: string;
    cutoverJournal: string | null;
  } | null;
}
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function validDirectory(value: unknown): value is DirectoryIdentity {
  const item = value as DirectoryIdentity;
  return (
    validIdentity(item) &&
    typeof item.path === 'string' &&
    isAbsolute(item.path)
  );
}
export function generationToken(anchor: BackupAnchor) {
  return { profileId: anchor.profileId, generation: anchor.generation };
}
function sameToken(value: unknown, anchor: BackupAnchor, previous = false) {
  const token = value as ReturnType<typeof generationToken>;
  return (
    token?.profileId === anchor.profileId &&
    token.generation ===
      (previous ? anchor.migration?.priorGeneration : anchor.generation)
  );
}
function terminal(journal: MigrationJournal | null) {
  return (
    !journal ||
    ['completed', 'failed', 'cancelled'].includes(journal.status.phase)
  );
}
export function decodeAnchor(value: unknown): BackupAnchor {
  const item = value as BackupAnchor;
  if (
    item?.format !== 'infinite-afflatus-app-backup-anchor' ||
    item.version !== 1 ||
    !UUID.test(item.profileId) ||
    !UUID.test(item.generation) ||
    !validDirectory(item.userData) ||
    !validDirectory(item.root) ||
    (item.initializing !== null &&
      (!validIdentity(item.initializing) ||
        !/^[a-f0-9]{64}$/.test(item.initializing.sha256))) ||
    (item.migration !== null &&
      (!item.migration ||
        !UUID.test(item.migration.id) ||
        !UUID.test(item.migration.priorGeneration) ||
        !validDirectory(item.migration.target) ||
        !['prepared', 'active', 'switching', 'target'].includes(
          item.migration.phase,
        ) ||
        !/^[a-f0-9]{64}$/.test(item.migration.priorJournal) ||
        (item.migration.cutoverJournal !== null &&
          !/^[a-f0-9]{64}$/.test(item.migration.cutoverJournal))))
  )
    throw new Error('应用备份恢复标记损坏或版本不受支持，未推断原目录');
  return item;
}
export async function readAnchor(userData: string): Promise<BackupAnchor> {
  const anchor = decodeAnchor(await readJson(join(userData, ANCHOR_FILE)));
  if (anchor.userData.path !== userData)
    throw new Error('此备份不属于当前应用资料目录');
  await verifyDirectory(anchor.userData);
  return anchor;
}
export async function stableAnchor(userData: string) {
  if (await info(join(userData, RELOCATION_FILE)))
    throw new Error('目录重定位尚未完成，不能恢复历史应用索引');
  const anchor = await readAnchor(userData);
  if (anchor.migration || anchor.initializing)
    throw new Error('目录迁移或恢复标记尚未稳定，不能恢复历史应用索引');
  await verifyDirectory(anchor.root);
  return anchor;
}
export function sameAnchor(a: BackupAnchor, b: BackupAnchor) {
  return (
    a.profileId === b.profileId &&
    a.generation === b.generation &&
    a.userData.path === b.userData.path &&
    sameIdentity(a.userData, b.userData) &&
    a.root.path === b.root.path &&
    sameIdentity(a.root, b.root) &&
    !a.initializing &&
    !b.initializing &&
    !a.migration &&
    !b.migration
  );
}

/** An independent routing generation must agree with the database before any old worker runs. */
export class BackupAnchorStore {
  constructor(
    private userData: string,
    private store: AppStore,
  ) {}
  private put(value: BackupAnchor, previous: BackupAnchor | null) {
    return writeJson(join(this.userData, ANCHOR_FILE), value, previous);
  }
  async initialize() {
    if (await info(join(this.userData, RELOCATION_FILE)))
      throw new Error('目录重定位尚未完成，未重放应用记录');
    const path = join(this.userData, ANCHOR_FILE);
    if (!(await info(path))) {
      if (this.store.hasSetting(GENERATION_KEY))
        throw new Error('独立应用恢复标记缺失，未重新认领旧数据库');
      for (const name of [
        BACKUP_DIRECTORY,
        RETAINED_DIRECTORY,
        RESTORE_FILE,
        RELOCATION_FILE,
        RELOCATION_DIRECTORY,
      ])
        if (await info(join(this.userData, name)))
          throw new Error('存在应用备份资料但独立恢复标记缺失，未重新认领');
      const legacy = this.store.get<MigrationJournal>('migration');
      if (!terminal(legacy) && legacy) {
        // Before this format existed, an interrupted migration had no independent
        // routing proof. Only admit it while the retained side still has every byte.
        if (legacy.switched) await verifyCutover(legacy);
        else
          for (const entry of legacy.files)
            if (entry.copied) {
              try {
                if (
                  !sameContent(
                    await fingerprint(
                      await safeFile(legacy.status.source, entry.relativePath),
                    ),
                    entry.source,
                  )
                )
                  throw new Error('原文件已变化');
              } catch {
                throw new Error(
                  '旧迁移的原文件不完整，已保留目标副本，不能自动认领清理权限',
                );
              }
            }
      }
      const anchor: BackupAnchor = {
        format: 'infinite-afflatus-app-backup-anchor',
        version: 1,
        profileId: randomUUID(),
        generation: randomUUID(),
        userData: await directoryIdentity(this.userData),
        root: await directoryIdentity(this.store.root),
        initializing: this.store.backupSourceEvidence(),
        migration: null,
      };
      if (!terminal(legacy) && legacy) {
        if (
          this.store.root !==
          (legacy.switched ? legacy.status.target : legacy.status.source)
        )
          throw new Error('旧迁移路由不一致，未自动认领');
        anchor.root = await directoryIdentity(legacy.status.source);
        anchor.migration = {
          id: legacy.status.id,
          target: await directoryIdentity(legacy.status.target),
          phase: legacy.switched ? 'target' : 'active',
          priorJournal: digest(legacy),
          priorGeneration: anchor.generation,
          cutoverJournal: null,
        };
      }
      await this.put(anchor, null);
    }
    let anchor = await readAnchor(this.userData);
    const token = this.store.get(GENERATION_KEY);
    if (anchor.initializing) {
      if (
        this.store.root !==
        (anchor.migration?.phase === 'target'
          ? anchor.migration.target.path
          : anchor.root.path)
      )
        throw new Error('初始化恢复标记的原项目目录已变化');
      await verifyDirectory(anchor.root);
      if (!sameToken(token, anchor)) {
        if (
          token !== null ||
          JSON.stringify(this.store.backupSourceEvidence()) !==
            JSON.stringify(anchor.initializing)
        )
          throw new Error(
            '初始化恢复标记的原数据库内容或身份已变化，未自动认领',
          );
        this.store.set(GENERATION_KEY, generationToken(anchor));
      }
      const ready = { ...anchor, initializing: null };
      await this.put(ready, anchor);
      anchor = ready;
    }
    const journal = this.store.get<MigrationJournal>('migration');
    if (!anchor.migration) {
      if (
        !sameToken(this.store.get(GENERATION_KEY), anchor) ||
        this.store.root !== anchor.root.path ||
        !terminal(journal)
      )
        throw new Error('应用数据库与独立恢复代际不符，未重放旧记录');
      await verifyDirectory(anchor.root);
      return;
    }
    const migration = anchor.migration;
    if (
      !sameToken(this.store.get(GENERATION_KEY), anchor) &&
      !sameToken(this.store.get(GENERATION_KEY), anchor, true)
    )
      throw new Error('应用迁移数据库代际不符，未重放旧记录');
    if (
      migration.phase === 'prepared' &&
      this.store.root === anchor.root.path
    ) {
      const untouched =
        digest(journal) === migration.priorJournal && terminal(journal);
      const planned =
        journal?.status.id === migration.id &&
        journal.status.source === anchor.root.path &&
        journal.status.target === migration.target.path &&
        !journal.switched &&
        journal.status.copied === 0 &&
        !Object.keys(journal.targetDirectories).length &&
        journal.files.every((file) => !file.copied);
      if (!untouched && !planned)
        throw new Error('迁移准备记录不符，未推断原目录');
      await verifyDirectory(anchor.root);
      if (planned && journal) {
        journal.status.phase = 'failed';
        journal.status.error = '上次迁移在准备期间中断，未开始复制';
        this.store.set('migration', journal);
      }
      this.store.set(GENERATION_KEY, generationToken(anchor));
      await this.put({ ...anchor, migration: null }, anchor);
      return;
    }
    if (
      !journal ||
      journal.status.id !== migration.id ||
      journal.status.source !== anchor.root.path ||
      journal.status.target !== migration.target.path
    )
      throw new Error('应用目录迁移记录与独立恢复标记不符，未重放旧记录');
    if (migration.phase === 'switching') {
      await verifyDirectory(migration.target);
      if (!journal.switched) {
        if (
          this.store.root !== anchor.root.path ||
          digest(journal) !== migration.cutoverJournal
        )
          throw new Error('迁移切换前的数据库证据不符，未回滚目标目录');
        await verifyCutover(journal, true);
        journal.switched = true;
        journal.status.phase = 'cleaning';
        this.store.commitLocation(
          migration.target.path,
          journal,
          generationToken(anchor),
        );
      }
      if (
        this.store.root !== migration.target.path ||
        !sameToken(this.store.get(GENERATION_KEY), anchor)
      )
        throw new Error('迁移切换结果代际不符');
      await this.put(
        { ...anchor, migration: { ...migration, phase: 'target' } },
        anchor,
      );
      return;
    }
    if (
      !sameToken(this.store.get(GENERATION_KEY), anchor) ||
      (migration.phase === 'target'
        ? !journal.switched || this.store.root !== migration.target.path
        : journal.switched || this.store.root !== anchor.root.path)
    )
      throw new Error('迁移方向与独立记录不符，未重放旧清理记录');
  }
  async beforeMigration(preview: MigrationPreview) {
    const previous = await stableAnchor(this.userData);
    if (
      !sameToken(this.store.get(GENERATION_KEY), previous) ||
      !terminal(this.store.get('migration'))
    )
      throw new Error('旧迁移或应用代际尚未稳定');
    if (
      preview.source !== previous.root.path ||
      preview.source !== this.store.root
    )
      throw new Error('项目目录已变化，请重新检查');
    await this.put(
      {
        ...previous,
        generation: randomUUID(),
        migration: {
          id: preview.token,
          target: await directoryIdentity(preview.target),
          phase: 'prepared',
          priorJournal: digest(this.store.get('migration')),
          priorGeneration: previous.generation,
          cutoverJournal: null,
        },
      },
      previous,
    );
  }
  async migrationStarted(preview: MigrationPreview) {
    const previous = await readAnchor(this.userData);
    const journal = this.store.get<MigrationJournal>('migration');
    if (
      !previous.migration ||
      previous.migration.id !== preview.token ||
      previous.migration.phase !== 'prepared' ||
      journal?.status.id !== preview.token
    )
      throw new Error('迁移代际确认失败，未开始复制');
    this.store.set(GENERATION_KEY, generationToken(previous));
    await this.put(
      { ...previous, migration: { ...previous.migration, phase: 'active' } },
      previous,
    );
  }
  async beforeCutover(journal: MigrationJournal) {
    const previous = await readAnchor(this.userData);
    if (
      previous.migration?.phase !== 'active' ||
      previous.migration.id !== journal.status.id ||
      journal.switched ||
      this.store.root !== previous.root.path
    )
      throw new Error('迁移切换方向无效');
    const next: BackupAnchor = {
      ...previous,
      generation: randomUUID(),
      migration: {
        ...previous.migration,
        phase: 'switching',
        priorGeneration: previous.generation,
        cutoverJournal: digest(journal),
      },
    };
    await this.put(next, previous);
    return generationToken(next);
  }
  async afterCutover() {
    const previous = await readAnchor(this.userData);
    if (
      previous.migration?.phase !== 'switching' ||
      this.store.root !== previous.migration.target.path ||
      !sameToken(this.store.get(GENERATION_KEY), previous)
    )
      throw new Error('迁移切换结果尚未确认，未开始旧目录清理');
    await this.put(
      { ...previous, migration: { ...previous.migration, phase: 'target' } },
      previous,
    );
  }
  async afterMigration() {
    const previous = await readAnchor(this.userData);
    if (!previous.migration) return;
    const journal = this.store.get<MigrationJournal>('migration');
    if (
      !journal ||
      journal.status.id !== previous.migration.id ||
      !terminal(journal)
    )
      return;
    const expected = journal.switched
      ? previous.migration.target
      : previous.root;
    if (this.store.root !== expected.path)
      throw new Error('迁移结果与独立恢复标记不符');
    await verifyDirectory(expected);
    this.store.set(GENERATION_KEY, generationToken(previous));
    await this.put({ ...previous, root: expected, migration: null }, previous);
  }
}
