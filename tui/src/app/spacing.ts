import type { Component, TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";

/** Adds one ordinary-background row before a component only while it has visible content. */
export class SpacedBlock implements Component {
  private readonly child: Component;
  constructor(child: Component) { this.child = child; }

  render(width: number): string[] {
    const lines = this.child.render(width);
    return lines.length === 0 ? [] : ["", ...lines];
  }

  invalidate(): void { this.child.invalidate?.(); }
  handleInput(data: string): void { this.child.handleInput?.(data); }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const lines = this.child.render(event.width);
    if (lines.length === 0 || event.y === 0) return undefined;
    return this.child.handleMouse?.({ ...event, y: event.y - 1, height: lines.length });
  }
}
