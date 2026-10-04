import { randomUUID } from 'node:crypto';
import { basename } from 'node:path';
import type {
  RescueImportPreview,
  RescueImportResult,
} from '../../shared/rescue-import';
import type { ProjectEditDraftService } from './project-edit-draft-service';
import {
  inspectRescueProject,
  type RescueProjectAccess,
} from './rescue-project';
import { isWorkspaceRescue, type RescueRecord } from './rescue-record';
import { readRescueSource } from './rescue-source';
import type { WorkspaceDraftService } from './workspace-draft-service';

export type { RescueProjectAccess } from './rescue-project';

const PREVIEW_LIFETIME = 5 * 60_000;
interface Ticket {
  owner: number;
  preview: RescueImportPreview;
  source: Awaited<ReturnType<typeof readRescueSource>>;
  evidence: string;
  imported: RescueRecord;
  pending?: Promise<RescueImportResult>;
}

/** Only publishes independent recovery records. Explicit restoration remains a separate action. */
export class RescueImportService {
  private readonly tickets = new Map<string, Ticket>();
  private readonly receipts = new Map<
    string,
    { owner: number; expiresAt: string; result: RescueImportResult }
  >();
  private readonly epochs = new Map<number, number>();
  private readonly active = new Set<Promise<unknown>>();
  private closing = false;
  constructor(
    private readonly drafts: WorkspaceDraftService,
    private readonly editDrafts: ProjectEditDraftService,
    private readonly access: RescueProjectAccess,
  ) {}

  private owner(value: number) {
    if (!Number.isSafeInteger(value) || value < 1)
      throw new Error('无效的救援文件导入窗口');
  }
  private track<T>(work: Promise<T>): Promise<T> {
    this.active.add(work);
    void work.finally(() => this.active.delete(work)).catch(() => undefined);
    return work;
  }
  private prune() {
    for (const [token, ticket] of this.tickets)
      if (!ticket.pending && Date.parse(ticket.preview.expiresAt) < Date.now())
        this.tickets.delete(token);
    for (const [token, receipt] of this.receipts)
      if (Date.parse(receipt.expiresAt) < Date.now())
        this.receipts.delete(token);
  }

  prepare(path: string, owner: number): Promise<RescueImportPreview> {
    this.owner(owner);
    if (this.closing)
      return Promise.reject(new Error('救援文件导入服务正在关闭'));
    this.clear(owner);
    this.prune();
    if (this.tickets.size + this.receipts.size >= 128)
      return Promise.reject(new Error('待确认的救援文件过多，请稍后重试'));
    const epoch = this.epochs.get(owner);
    const check = () => {
      if (this.closing || this.epochs.get(owner) !== epoch)
        throw new Error('救援文件检查已取消');
    };
    return this.track(
      this.access.run(async () => {
        check();
        this.access.assertAvailable();
        const source = await readRescueSource(path, check);
        const inspected = await inspectRescueProject(
          this.access,
          source.record,
        );
        check();
        const record = source.record;
        const preview: RescueImportPreview = {
          token: randomUUID(),
          expiresAt: new Date(Date.now() + PREVIEW_LIFETIME).toISOString(),
          kind: isWorkspaceRescue(record) ? 'workspace' : record.kind,
          sourceName: basename(source.path),
          sourceBytes: source.size,
          project: inspected.project,
          updatedAt: record.updatedAt,
          state: inspected.state,
          referenceCount: inspected.referenceCount,
          shotCount: isWorkspaceRescue(record)
            ? record.workspace.shots.length
            : 0,
          nameTarget:
            !isWorkspaceRescue(record) && record.kind === 'name'
              ? record.target
              : null,
          nameBaseline:
            !isWorkspaceRescue(record) && record.kind === 'name'
              ? record.baseline
              : null,
          cardId:
            !isWorkspaceRescue(record) && record.kind === 'trim'
              ? record.baseline.id
              : null,
        };
        const imported = {
          ...record,
          sessionId: `rescue-${randomUUID()}`,
          seq: 1,
          ...(isWorkspaceRescue(record) ? { saved: false } : {}),
        };
        this.tickets.set(preview.token, {
          owner,
          preview,
          source,
          evidence: inspected.evidence,
          imported,
        });
        return structuredClone(preview);
      }),
    );
  }

  confirm(token: string, owner: number): Promise<RescueImportResult> {
    this.owner(owner);
    if (this.closing)
      return Promise.reject(new Error('救援文件导入服务正在关闭'));
    const receipt = this.receipts.get(token);
    if (receipt) {
      if (receipt.owner !== owner)
        return Promise.reject(new Error('救援文件预览无效，请重新检查'));
      if (Date.parse(receipt.expiresAt) < Date.now()) {
        this.receipts.delete(token);
        return Promise.reject(new Error('救援文件预览已过期，请重新检查'));
      }
      return Promise.resolve(structuredClone(receipt.result));
    }
    const ticket = this.tickets.get(token);
    if (!ticket || ticket.owner !== owner)
      return Promise.reject(new Error('救援文件预览无效，请重新检查'));
    if (Date.parse(ticket.preview.expiresAt) < Date.now()) {
      this.tickets.delete(token);
      return Promise.reject(new Error('救援文件预览已过期，请重新检查'));
    }
    if (ticket.pending)
      return ticket.pending.then((result) => structuredClone(result));
    const work = this.access.run(async () => {
      if (Date.parse(ticket.preview.expiresAt) < Date.now())
        throw new Error('救援文件预览已过期，请重新检查');
      const verify = async () => {
        this.access.assertAvailable();
        const source = await readRescueSource(ticket.source.path);
        if (
          source.identity !== ticket.source.identity ||
          source.digest !== ticket.source.digest
        )
          throw new Error('救援文件在预览后变化，请重新检查；原文件未修改');
        const inspected = await inspectRescueProject(
          this.access,
          ticket.source.record,
        );
        if (inspected.evidence !== ticket.evidence)
          throw new Error('原项目或引用素材在预览后变化，请重新检查');
      };
      const added = isWorkspaceRescue(ticket.imported)
        ? await this.drafts.addRescue(ticket.imported, verify)
        : await this.editDrafts.addRescue(ticket.imported, verify);
      const result: RescueImportResult = {
        projectId: added.record.project.id,
        kind: ticket.preview.kind,
        key: { sessionId: added.record.sessionId, seq: added.record.seq },
        duplicate: added.duplicate,
      };
      this.receipts.set(token, {
        owner,
        expiresAt: ticket.preview.expiresAt,
        result,
      });
      this.tickets.delete(token);
      return result;
    });
    ticket.pending = work;
    void work
      .finally(() => {
        delete ticket.pending;
      })
      .catch(() => undefined);
    return this.track(work).then((result) => structuredClone(result));
  }

  clear(owner: number): void {
    this.owner(owner);
    this.epochs.set(owner, (this.epochs.get(owner) ?? 0) + 1);
    for (const [token, ticket] of this.tickets)
      if (ticket.owner === owner && !ticket.pending) this.tickets.delete(token);
  }

  async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.active]);
    this.tickets.clear();
    this.receipts.clear();
    this.epochs.clear();
  }
}
