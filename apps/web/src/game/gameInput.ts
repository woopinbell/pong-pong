export type EditableTarget = {
  tagName?: string;
  isContentEditable?: boolean;
};

// 방향키와 WASD 둘 다 지원 — 키보드 배치나 습관에 따라 편한 쪽을 쓸 수 있게 한 단순한 게임 조작 설계 선택.
export function directionForKey(key: string): -1 | 0 | 1 | null {
  if (key === "ArrowUp" || key === "w" || key === "W") return -1;
  if (key === "ArrowDown" || key === "s" || key === "S") return 1;
  return null;
}

// [INTV:EDGE] 키 입력이 일어난 대상(target)이 텍스트를 입력받는 요소(input/textarea/select, 또는
// contenteditable)인지 확인한다 — 채팅창에 "w"를 타이핑하는 중에 그게 패들 조작으로도 먹혀버리는
// 걸 막기 위한 가드로 쓰인다(전역 keydown 리스너를 다는 게임 UI에서 흔히 빠뜨리는 체크 — 이게
// 없으면 채팅 입력 중 방향키/WASD를 누를 때마다 패들이 함께 움직인다).
export function isEditableTarget(target: EditableTarget | null): boolean {
  if (!target) return false;
  return Boolean(
    target.isContentEditable
    || (target.tagName && ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName.toUpperCase()))
  );
}
