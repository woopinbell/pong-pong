export type EditableTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

export function directionForKey(key: string): -1 | 0 | 1 | null {
  if (key === "ArrowUp" || key === "w" || key === "W") return -1;
  if (key === "ArrowDown" || key === "s" || key === "S") return 1;
  return null;
}

export function isEditableTarget(target: EditableTarget | null): boolean {
  if (!target) return false;
  return Boolean(
    target.isContentEditable
    || (target.tagName && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName.toUpperCase()))
  );
}
