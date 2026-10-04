import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { MessageBoxOptions } from 'electron';
import { restoreAppBackupFromDialogs } from '../src/main/startup/app-backup-dialogs';
import { runStartupRecovery } from '../src/main/startup/startup-recovery';
import type {
  AppBackupInfo,
  AppBackupRecoveryReport,
} from '../src/shared/app-backup';

const info: AppBackupInfo = {
  id: 'one',
  createdAt: '2026-10-05T01:02:03.000Z',
  appVersion: '0.1.0',
  root: '/original/projects',
  bytes: 8192,
  sha256: 'a'.repeat(64),
  projectCount: 2,
  saveCount: 3,
  restorable: true,
  reason: null,
};
const report: AppBackupRecoveryReport = {
  backupId: info.id,
  restoredAt: '2026-10-05T02:02:03.000Z',
  retainedDirectory: '/profile/retained',
  retainedJobCount: 3,
  retainedFileCount: 4,
  warning: '原任务记录和暂存文件保留，未自动执行。',
};
function fixture(responses: number[]) {
  const events: string[] = [];
  const boxes: MessageBoxOptions[] = [];
  const service = {
    list: async () => ({
      directory: '/profile/backups',
      backups: [info],
      issues: [],
      recovery: null,
    }),
    preview: async (id: string) => {
      events.push(`preview:${id}`);
      return {
        token: 'exact-preview',
        expiresAt: '2026-10-05T03:00:00.000Z',
        backup: info,
        projectCount: 2,
        retainedJobCount: 3,
        retainedFileCount: 4,
        warnings: [],
      };
    },
    restore: async (token: string) => {
      events.push(`restore:${token}`);
      return {
        backupId: info.id,
        retainedDirectory: report.retainedDirectory,
        report,
      };
    },
  };
  const dialogs = {
    showMessageBox: async (options: MessageBoxOptions) => {
      boxes.push(options);
      return { response: responses.shift() ?? 0, checkboxChecked: false };
    },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] as string[] }),
  };
  return { service, dialogs, events, boxes };
}

test('backup inspection and confirmation cancellation never replace storage or re-open a library', async () => {
  const first = fixture([2]);
  assert.equal(
    await restoreAppBackupFromDialogs(first.service, first.dialogs),
    false,
  );
  assert.deepEqual(first.events, []);
  const checked = fixture([0, 1]);
  assert.equal(
    await restoreAppBackupFromDialogs(checked.service, checked.dialogs),
    false,
  );
  assert.deepEqual(checked.events, ['preview:one']);
  assert.equal(checked.boxes[1]?.defaultId, 1);
  assert.equal(checked.boxes[1]?.cancelId, 1);
  assert.match(checked.boxes[1]?.detail ?? '', /3 条历史任务和 4 个暂存文件/);
  assert.match(checked.boxes[1]?.detail ?? '', /项目内容与素材保持现状/);
});

test('startup restore uses only the exact preview token after explicit confirmation; failures never show success', async () => {
  const f = fixture([0, 0, 0]);
  assert.equal(await restoreAppBackupFromDialogs(f.service, f.dialogs), true);
  assert.deepEqual(f.events, ['preview:one', 'restore:exact-preview']);
  assert.match(f.boxes[2]?.detail ?? '', /\/profile\/retained/);
  const failure = fixture([0, 0]);
  failure.service.restore = async () => {
    throw new Error('预览已变化');
  };
  await assert.rejects(
    restoreAppBackupFromDialogs(failure.service, failure.dialogs),
    /预览已变化/,
  );
  assert.equal(failure.boxes.length, 2);
});

test('native picker only selects a listed backup in this profile; an unrelated same-named folder is refused', async (t) => {
  const base = await realpath(
    await mkdtemp(join(tmpdir(), 'afflatus-backup-choice-')),
  );
  t.after(() => rm(base, { recursive: true, force: true }));
  const directory = join(base, 'backups');
  const selected = join(directory, info.id);
  const other = join(base, 'other', info.id);
  await mkdir(selected, { recursive: true });
  await mkdir(other, { recursive: true });
  for (const [path, allowed] of [
    [selected, true],
    [other, false],
  ] as const) {
    const f = fixture([1, 0, 0]);
    f.service.list = async () => ({
      directory,
      backups: [info],
      issues: [],
      recovery: null,
    });
    f.dialogs.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [path],
    });
    if (allowed) {
      assert.equal(
        await restoreAppBackupFromDialogs(f.service, f.dialogs),
        true,
      );
      assert.deepEqual(f.events, ['preview:one', 'restore:exact-preview']);
    } else {
      await assert.rejects(
        restoreAppBackupFromDialogs(f.service, f.dialogs),
        /不属于/,
      );
      assert.deepEqual(f.events, []);
    }
  }
});

test('startup loop retries only after successful explicit restore; cancelled or failed recovery keeps the failure view', async () => {
  let opened = 0;
  let restores = 0;
  const messages: (string | null)[] = [];
  const result = await runStartupRecovery(
    async () => {
      if (++opened === 1) throw new Error('损坏库');
      return 'opened';
    },
    async (_failure, message) => {
      messages.push(message);
      return 'restore-backup';
    },
    async () => {
      assert.fail('No reveal expected');
    },
    async () => {
      restores++;
      if (restores === 1) return false;
      if (restores === 2) throw new Error('原文件已变化');
      return true;
    },
  );
  assert.equal(result, 'opened');
  assert.equal(opened, 2);
  assert.equal(restores, 3);
  assert.deepEqual(messages, [null, null, '备份恢复未完成：原文件已变化']);
});
