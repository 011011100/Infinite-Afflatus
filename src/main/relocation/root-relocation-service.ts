import { randomUUID } from 'node:crypto';
import { mkdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import {
  childDirectory,
  directoryIdentity,
  info,
  writeJson,
} from '../backups/backup-files';
import { syncDirectory } from '../storage/files';
import { makeCandidate } from './relocation-database';
import { same } from './relocation-files';
import {
  inspectApplication,
  inspectRelocation,
} from './root-relocation-inspection';
import {
  finishRelocation,
  resumeRelocation,
} from './root-relocation-publication';
import {
  RELOCATION_DIRECTORY,
  RELOCATION_FILE,
  type RelocationInspection,
  type RelocationIntent,
  type RootRelocationPreview,
  type RootRelocationResult,
} from './root-relocation-types';

export type {
  RootRelocationPreview,
  RootRelocationResult,
} from './root-relocation-types';

/** Offline startup-only service. Preview/cancel never writes; confirmed publication must settle. */
export class RootRelocationService {
  private ticket: {
    preview: RootRelocationPreview;
    inspection: RelocationInspection;
  } | null = null;
  private operation: Promise<unknown> | null = null;
  private controller: AbortController | null = null;
  private closing = false;
  private epoch = 0;
  constructor(private userData: string) {}
  private async location() {
    this.userData = await realpath(this.userData);
    await directoryIdentity(this.userData);
    return this.userData;
  }
  private run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closing || this.operation)
      return Promise.reject(new Error('目录重新定位正在进行或应用正在关闭'));
    const operation = Promise.resolve().then(fn);
    this.operation = operation;
    void operation
      .finally(() => {
        if (this.operation === operation) this.operation = null;
      })
      .catch(() => {});
    return operation;
  }
  async available(): Promise<boolean> {
    if (this.closing || this.operation) return false;
    try {
      await inspectApplication(await this.location());
      return !this.closing;
    } catch {
      return false;
    }
  }
  preview(path: string): Promise<RootRelocationPreview> {
    const epoch = ++this.epoch;
    this.ticket = null;
    return this.run(async () => {
      if (this.closing || epoch !== this.epoch)
        throw new Error('已取消重新定位检查');
      const controller = new AbortController();
      this.controller = controller;
      try {
        const inspection = await inspectRelocation(
          await this.location(),
          path,
          controller.signal,
        );
        controller.signal.throwIfAborted();
        if (this.closing || epoch !== this.epoch)
          throw new Error('已取消重新定位检查');
        const preview: RootRelocationPreview = {
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
          oldRoot: inspection.anchor.root.path,
          newRoot: inspection.root.path,
          projects: inspection.projects.map(({ project }) => ({
            id: project.id,
            name: project.name,
          })),
          pendingSaveCount: inspection.pendingSaveCount,
        };
        this.ticket = { preview, inspection };
        return preview;
      } finally {
        if (this.controller === controller) this.controller = null;
      }
    });
  }
  confirm(token: string): Promise<RootRelocationResult> {
    const ticket = this.ticket;
    if (
      !ticket ||
      ticket.preview.token !== token ||
      Date.now() >= Date.parse(ticket.preview.expiresAt)
    )
      return Promise.reject(new Error('目录预览已失效，请重新检查'));
    this.ticket = null;
    return this.run(async () => {
      const userData = await this.location();
      if (
        !same(
          await inspectRelocation(userData, ticket.preview.newRoot),
          ticket.inspection,
        )
      )
        throw new Error('预览后资料发生变化，请重新检查');
      const parent = await childDirectory(userData, RELOCATION_DIRECTORY);
      const id = randomUUID();
      const path = join(parent, id);
      await mkdir(path, { mode: 0o700 });
      await syncDirectory(parent);
      const retained = await directoryIdentity(path);
      const resultAnchor = {
        ...ticket.inspection.anchor,
        root: ticket.inspection.root,
        generation: randomUUID(),
      };
      const candidate = await makeCandidate(
        join(userData, 'app.sqlite'),
        join(path, 'new-app.sqlite'),
        ticket.inspection.original,
        resultAnchor,
      );
      if (
        !same(
          await inspectRelocation(userData, ticket.preview.newRoot),
          ticket.inspection,
        )
      )
        throw new Error('准备重定位期间资料发生变化，原资料已保留');
      const intent: RelocationIntent = {
        format: 'infinite-afflatus-root-relocation',
        version: 1,
        id,
        anchor: ticket.inspection.anchor,
        resultAnchor,
        original: ticket.inspection.original,
        candidate,
        projects: ticket.inspection.projects,
        retained,
      };
      await writeJson(join(userData, RELOCATION_FILE), intent, null);
      await finishRelocation(userData, intent);
      return { root: resultAnchor.root.path, retainedDirectory: path };
    });
  }
  cancel(): void {
    ++this.epoch;
    this.ticket = null;
    this.controller?.abort(new Error('已取消重新定位检查'));
  }
  resumePending(): Promise<void> {
    return this.run(async () => {
      if (!(await info(this.userData))) return;
      await resumeRelocation(await this.location());
    });
  }
  async close(): Promise<void> {
    this.closing = true;
    this.cancel();
    await this.operation?.catch(() => {});
  }
}
