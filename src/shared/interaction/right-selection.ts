import { DRAG_THRESHOLD } from './long-press';

export type SelectionPoint = { x: number; y: number };
export type SelectionBox = SelectionPoint & { width: number; height: number };
type Press = {
  pointerId: number;
  start: SelectionPoint;
  before: string[];
  additive: boolean;
  dragged: boolean;
  contextRequested: boolean;
};

/** Context menus arrive on press on some systems and on release on others. */
export class RightSelection {
  private press: Press | null = null;
  private suppressMenu = false;

  get active() {
    return this.press !== null;
  }

  start(
    pointerId: number,
    point: SelectionPoint,
    before: string[],
    additive: boolean,
  ) {
    this.suppressMenu = false;
    this.press = {
      pointerId,
      start: point,
      before: [...before],
      additive,
      dragged: false,
      contextRequested: false,
    };
  }

  move(pointerId: number, point: SelectionPoint) {
    const press = this.press;
    if (!press || pointerId !== press.pointerId) return null;
    press.dragged ||=
      Math.hypot(point.x - press.start.x, point.y - press.start.y) >
      DRAG_THRESHOLD;
    if (!press.dragged) return null;
    return {
      box: {
        x: Math.min(point.x, press.start.x),
        y: Math.min(point.y, press.start.y),
        width: Math.abs(point.x - press.start.x),
        height: Math.abs(point.y - press.start.y),
      },
      before: press.before,
      additive: press.additive,
    };
  }

  contextMenu(): 'open' | 'defer' | 'suppress' {
    if (this.suppressMenu || this.press?.dragged) return 'suppress';
    if (!this.press) return 'open';
    this.press.contextRequested = true;
    return 'defer';
  }

  release(pointerId: number, point: SelectionPoint) {
    if (!this.press || pointerId !== this.press.pointerId) return null;
    const selection = this.move(pointerId, point);
    const openMenu = !this.press.dragged && this.press.contextRequested;
    this.suppressMenu = this.press.dragged;
    this.press = null;
    return { selection, openMenu };
  }

  cancel() {
    const before = this.press?.dragged ? this.press.before : null;
    if (this.press) this.suppressMenu = true;
    this.press = null;
    return before;
  }

  resetMenu() {
    this.suppressMenu = false;
  }
}
