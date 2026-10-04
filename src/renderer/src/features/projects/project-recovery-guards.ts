import type { ProjectSnapshot } from '../../../../shared/models';

type Guard = (
  snapshot: ProjectSnapshot,
) => Promise<string | null> | string | null;

/** Editors retain their own confirmed baselines and drafts; recovery only asks whether resuming is safe. */
export class ProjectRecoveryGuards {
  private entries = new Map<string, Set<Guard>>();
  register(projectId: string, guard: Guard) {
    const entries = this.entries.get(projectId) ?? new Set<Guard>();
    entries.add(guard);
    this.entries.set(projectId, entries);
    return () => {
      entries.delete(guard);
      if (!entries.size) this.entries.delete(projectId);
    };
  }
  async verify(
    projectId: string,
    snapshot: ProjectSnapshot,
  ): Promise<string | null> {
    for (const guard of this.entries.get(projectId) ?? []) {
      const reason = await guard(snapshot);
      if (reason) return reason;
    }
    return null;
  }
}

export const projectRecoveryGuards = new ProjectRecoveryGuards();
