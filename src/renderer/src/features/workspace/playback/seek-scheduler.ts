export type SeekTarget = { index: number; time: number };

type Job = { target: SeekTarget; latest: SeekTarget };

/** Finish a decode before chasing the newest time; never queue obsolete frames. */
export class SeekScheduler {
  private job: Job | null = null;

  constructor(
    private run: (target: SeekTarget) => Promise<void>,
    private settled: () => void,
  ) {}

  get target(): SeekTarget | null {
    return this.job?.latest ?? null;
  }

  request(target: SeekTarget, final = false): void {
    // Release is an exact destination, so don't wait for an obsolete decode.
    if (
      final &&
      this.job &&
      (this.job.target.index !== target.index ||
        this.job.target.time !== target.time)
    )
      this.cancel();
    if (this.job?.target.index === target.index) {
      this.job.latest = target;
      return;
    }
    // Changing clips supersedes a slow load immediately. The player cancels
    // its old operation; its eventual completion cannot drain the new job.
    const job = { target, latest: target };
    this.job = job;
    void this.drain(job);
  }

  cancel(): void {
    this.job = null;
  }

  private async drain(job: Job): Promise<void> {
    while (this.job === job) {
      const target = job.latest;
      job.target = target;
      await this.run(target);
      if (this.job !== job) return;
      if (job.latest.time === target.time) {
        this.job = null;
        this.settled();
        return;
      }
    }
  }
}
