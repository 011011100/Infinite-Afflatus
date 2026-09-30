import { DRAG_THRESHOLD, LONG_PRESS_MS } from './long-press';

/** A hold picks up a block; only a subsequent drag/drop edits membership or order. */
export class BlockDrag {
  private press: {
    id: number;
    x: number;
    y: number;
    at: number;
    lifted: boolean;
  } | null = null;
  start(id: number, x: number, y: number, at: number) {
    this.press = { id, x, y, at, lifted: false };
  }
  get active() {
    return this.press !== null;
  }
  lift(at: number) {
    if (!this.press || at - this.press.at < LONG_PRESS_MS) return false;
    this.press.lifted = true;
    return true;
  }
  move(id: number, x: number, y: number) {
    if (this.press?.id !== id) return false;
    if (
      !this.press.lifted &&
      Math.hypot(x - this.press.x, y - this.press.y) > DRAG_THRESHOLD
    )
      this.cancel();
    return this.press?.lifted ?? false;
  }
  release(id: number, x: number, y: number) {
    const press = this.press;
    if (press?.id !== id) return false;
    this.cancel();
    return (
      press.lifted && Math.hypot(x - press.x, y - press.y) > DRAG_THRESHOLD
    );
  }
  cancel() {
    this.press = null;
  }
}
