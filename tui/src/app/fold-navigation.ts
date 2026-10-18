/** Shared keyboard navigation for independently collapsible transcript items. */
type FoldItem = { toggle: () => void; select: (selected: boolean) => void };
const items: FoldItem[] = [];
let selected = -1;

export function registerFoldItem(item: FoldItem): void {
  items.push(item);
  selected = items.length - 1;
  item.select(true);
}

export function selectFoldItem(delta: number): void {
  if (items.length === 0) return;
  if (selected < 0) selected = 0;
  items[selected]?.select(false);
  selected = (selected + delta + items.length) % items.length;
  items[selected]?.select(true);
}

export function toggleSelectedFoldItem(): void { items[selected]?.toggle(); }
