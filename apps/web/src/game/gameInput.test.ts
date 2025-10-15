import { describe, expect, it } from "vitest";
import { directionForKey, isEditableTarget } from "./gameInput";

describe("game input", () => {
  it.each([
    ["ArrowUp", -1],
    ["w", -1],
    ["W", -1],
    ["ArrowDown", 1],
    ["s", 1],
    ["S", 1],
    ["Enter", null]
  ] as const)("maps %s to the shared direction command", (key, direction) => {
    expect(directionForKey(key)).toBe(direction);
  });

  it.each(["INPUT", "TEXTAREA", "SELECT"])("ignores keyboard input from %s controls", (tagName) => {
    expect(isEditableTarget({ tagName, isContentEditable: false })).toBe(true);
  });

  it("ignores keyboard input from contenteditable elements", () => {
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: true })).toBe(true);
    expect(isEditableTarget({ tagName: "DIV", isContentEditable: false })).toBe(false);
  });
});
