export const LONG_PRESS_MS = 700;
export const HOLD_HINT_DELAY_MS = 150;
export const DRAG_THRESHOLD = 5;

interface Press {
  pointerId: number;
  x: number;
  y: number;
  startedAt: number;
}

/** No mutation until release, so moving away or cancelling never splits a card. */
export class LongPress {
  private press: Press | null = null;

  start(pointerId: number, x: number, y: number, now: number): void {
    this.press = { pointerId, x, y, startedAt: now };
  }

  move(pointerId: number, x: number, y: number): boolean {
    const press = this.press;
    if (
      press?.pointerId === pointerId &&
      Math.hypot(x - press.x, y - press.y) > DRAG_THRESHOLD
    )
      this.cancel();
    return this.press !== null;
  }

  release(pointerId: number, now: number): boolean {
    const press = this.press;
    if (!press || press.pointerId !== pointerId) return false;
    this.cancel();
    return now - press.startedAt >= LONG_PRESS_MS;
  }

  cancel(): void {
    this.press = null;
  }
}
