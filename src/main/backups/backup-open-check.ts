import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { MigrationJournal } from '../migration/manifest';
import { verifyAppStore } from '../storage/app-store-guard';
import { openDatabase } from '../storage/database';
import { GENERATION_KEY, generationToken, readAnchor } from './backup-anchor';
import { ANCHOR_FILE, info } from './backup-files';

/** Reject stale routing before AppStore can apply writable PRAGMAs to an old database. */
export async function preflightBackupAnchor(userData: string, file: string) {
  if (!(await info(join(userData, ANCHOR_FILE)))) return;
  const anchor = await readAnchor(userData);
  const db = openDatabase(file, true);
  try {
    const root = verifyAppStore(db);
    const setting = (key: string): unknown => {
      const row = db
        .prepare('SELECT value FROM settings WHERE key = ?')
        .get(key);
      return row ? JSON.parse(String(row.value)) : null;
    };
    const token = setting(GENERATION_KEY);
    const journal = setting('migration') as MigrationJournal | null;
    const current =
      JSON.stringify(token) === JSON.stringify(generationToken(anchor));
    const previous =
      anchor.migration &&
      JSON.stringify(token) ===
        JSON.stringify({
          profileId: anchor.profileId,
          generation: anchor.migration.priorGeneration,
        });
    if (anchor.initializing && token === null) {
      const stat = lstatSync(file, { bigint: true });
      const hash = createHash('sha256');
      for (const [table, order] of [
        ['settings', 'key'],
        ['projects', 'id'],
        ['saves', 'id'],
      ]) {
        hash.update(table ?? '');
        for (const row of db
          .prepare(`SELECT * FROM ${table} ORDER BY ${order}`)
          .iterate())
          hash.update(JSON.stringify(row));
      }
      if (
        JSON.stringify({
          dev: String(stat.dev),
          ino: String(stat.ino),
          birthtimeNs: String(stat.birthtimeNs),
          sha256: hash.digest('hex'),
        }) !== JSON.stringify(anchor.initializing)
      )
        throw new Error(
          '初始化恢复标记的原数据库内容或身份已变化，未修改原文件',
        );
      return;
    }
    const migration = anchor.migration;
    if (!migration) {
      if (
        !current ||
        root !== anchor.root.path ||
        (journal &&
          !['completed', 'failed', 'cancelled'].includes(journal.status.phase))
      )
        throw new Error('应用数据库与独立恢复代际不符，未修改或重放旧记录');
      return;
    }
    if (!current && !previous)
      throw new Error('应用迁移数据库代际不符，原文件未修改');
    if (migration.phase === 'prepared') {
      if (root !== anchor.root.path)
        throw new Error('迁移准备的原项目位置不符');
      return;
    }
    if (
      journal?.status.id !== migration.id ||
      journal.status.source !== anchor.root.path ||
      journal.status.target !== migration.target.path
    )
      throw new Error('应用目录迁移记录不符，原文件未修改');
    if (
      migration.phase === 'target' &&
      (!current || !journal.switched || root !== migration.target.path)
    )
      throw new Error('旧数据库迁移方向与独立记录不符，原文件未修改');
    if (
      migration.phase === 'active' &&
      (!current || journal.switched || root !== anchor.root.path)
    )
      throw new Error('旧数据库迁移方向与独立记录不符，原文件未修改');
    if (migration.phase === 'switching') {
      if (
        journal.switched
          ? !current || root !== migration.target.path
          : root !== anchor.root.path ||
            createHash('sha256')
              .update(JSON.stringify(journal))
              .digest('hex') !== migration.cutoverJournal
      )
        throw new Error('迁移切换证据不符，原文件未修改');
    }
  } finally {
    db.close();
  }
}
