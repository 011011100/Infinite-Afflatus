import type { DesktopBridge } from '../../../../shared/desktop';
import type {
  Asset,
  LibraryState,
  ProjectSnapshot,
} from '../../../../shared/models';
import type { ProjectRecoverySnapshot } from '../../../../shared/project-recovery';

export interface ProjectUnavailable {
  projectId: string;
  message: string;
  lastVerifiedAt: string | null;
  retrying: boolean;
  conflict: boolean;
}
interface SessionState {
  library: LibraryState | null;
  project: ProjectSnapshot | null;
  projectUnavailable: ProjectUnavailable | null;
}

export const projectErrorMessage = (reason: unknown) =>
  reason instanceof Error
    ? reason.message.replace(
        /^Error invoking remote method '[^']+': (Error: )?/,
        '',
      )
    : String(reason);

/** Global library status and the active project's last verified view have independent lifetimes. */
export class LibrarySession {
  private state: SessionState = {
    library: null,
    project: null,
    projectUnavailable: null,
  };
  private listeners = new Set<() => void>();
  private libraryEpoch = 0;
  private projectEpoch = 0;
  private internalChangeEpoch = 0;
  private pendingInternalChange = false;
  private lastVerifiedAt: string | null = null;
  constructor(
    private readonly desktop: Pick<DesktopBridge, 'getLibrary' | 'openProject'>,
    private readonly verifyRecovery: (
      projectId: string,
      snapshot: ProjectSnapshot,
      savedReferenceAssets?: Asset[],
    ) => Promise<string | null> = async () => null,
    private readonly readRecovery: (
      id: string,
    ) => Promise<ProjectRecoverySnapshot> = async (id) => ({
      snapshot: await desktop.openProject(id),
      savedReferenceAssets: [],
    }),
  ) {}

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(changes: Partial<SessionState>) {
    this.state = { ...this.state, ...changes };
    for (const listener of this.listeners) listener();
  }
  activate(snapshot: ProjectSnapshot) {
    this.projectEpoch++;
    this.lastVerifiedAt = new Date().toISOString();
    this.publish({ project: snapshot, projectUnavailable: null });
  }
  home() {
    this.projectEpoch++;
    this.lastVerifiedAt = null;
    this.publish({ project: null, projectUnavailable: null });
  }
  failProject(reason: unknown) {
    const id = this.state.project?.project.id;
    if (!id) return;
    // In-flight reads begun before the failed write cannot subsequently unlock editing.
    this.projectEpoch++;
    this.publish({
      projectUnavailable: {
        projectId: id,
        message: projectErrorMessage(reason),
        lastVerifiedAt: this.lastVerifiedAt,
        retrying: false,
        conflict: false,
      },
    });
  }
  dispose() {
    this.libraryEpoch++;
    this.projectEpoch++;
  }
  /** A queued save can publish after its originating import dialog has already finished. */
  noteLibraryChange() {
    this.pendingInternalChange = true;
    this.internalChangeEpoch++;
  }

  async refresh(verifyActive = false) {
    const request = ++this.libraryEpoch;
    const changeEpoch = this.internalChangeEpoch;
    const library = await this.desktop.getLibrary();
    if (request !== this.libraryEpoch) return;
    this.publish({ library });
    // Include notifications received during the library read. Their ordinary
    // refresh establishes the acknowledged view before strict focus comparison.
    const verify = verifyActive && !this.pendingInternalChange;
    await this.refreshProject(false, verify);
    if (
      request === this.libraryEpoch &&
      changeEpoch === this.internalChangeEpoch
    )
      this.pendingInternalChange = false;
  }

  async open(id: string) {
    const request = ++this.projectEpoch;
    const snapshot = await this.desktop.openProject(id);
    if (request === this.projectEpoch) this.activate(snapshot);
  }

  async refreshProject(retry = false, verifyActive = false): Promise<boolean> {
    const id = this.state.project?.project.id;
    if (!id || (this.state.projectUnavailable && !retry)) return false;
    const request = ++this.projectEpoch;
    const changeEpoch = this.internalChangeEpoch;
    if (retry && this.state.projectUnavailable)
      this.publish({
        projectUnavailable: {
          ...this.state.projectUnavailable,
          retrying: true,
        },
      });
    const current = () =>
      request === this.projectEpoch &&
      id === this.state.project?.project.id &&
      (!verifyActive || changeEpoch === this.internalChangeEpoch);
    try {
      const strict = (retry && !!this.state.projectUnavailable) || verifyActive;
      let recovery = strict ? await this.readRecovery(id) : null;
      let snapshot = recovery?.snapshot ?? (await this.desktop.openProject(id));
      if (!current()) return false;
      const previous = this.state.project;
      const suspiciousCanvas =
        previous &&
        (snapshot.canvas.revision < previous.canvas.revision ||
          (snapshot.canvas.revision === previous.canvas.revision &&
            JSON.stringify(snapshot.assets) ===
              JSON.stringify(previous.assets) &&
            JSON.stringify(snapshot.canvas) !==
              JSON.stringify(previous.canvas)));
      if (strict || suspiciousCanvas) {
        if (!recovery) {
          recovery = await this.readRecovery(id);
          snapshot = recovery.snapshot;
          if (!current()) return false;
        }
        let conflict = await this.verifyRecovery(
          id,
          snapshot,
          recovery.savedReferenceAssets,
        );
        // A just-acknowledged in-flight write may have settled while guards waited.
        // Read once more before classifying that transient baseline as a conflict.
        if (conflict && verifyActive && current()) {
          recovery = await this.readRecovery(id);
          snapshot = recovery.snapshot;
          if (!current()) return false;
          conflict = await this.verifyRecovery(
            id,
            snapshot,
            recovery.savedReferenceAssets,
          );
        }
        if (!current()) return false;
        if (conflict) {
          this.publish({
            projectUnavailable: {
              projectId: id,
              message: conflict,
              lastVerifiedAt: this.lastVerifiedAt,
              retrying: false,
              conflict: true,
            },
          });
          return false;
        }
      }
      this.lastVerifiedAt = new Date().toISOString();
      this.publish({ project: snapshot, projectUnavailable: null });
      return true;
    } catch (reason) {
      if (current())
        this.publish({
          projectUnavailable: {
            projectId: id,
            message: projectErrorMessage(reason),
            lastVerifiedAt: this.lastVerifiedAt,
            retrying: false,
            conflict: false,
          },
        });
      return false;
    }
  }
}
