import { describe, expect, it } from "vitest";
import { InputGate } from "./inputGate";

describe("InputGate", () => {
  it("allows a short burst and then sustains thirty inputs per second", () => {
    const gate = new InputGate({ ratePerSecond: 30, burstCapacity: 8 });
    const input = (inputSeq: number, nowMs: number) => gate.check({
      userId: "user-1",
      roomId: "room-1",
      inputSeq,
      nowMs
    });

    for (let inputSeq = 0; inputSeq < 8; inputSeq += 1) {
      expect(input(inputSeq, 0)).toBe("accepted");
    }
    expect(input(8, 0)).toBe("rate_limited");

    for (let tenth = 1; tenth <= 10; tenth += 1) {
      const nowMs = tenth * 100;
      const firstSequence = 8 + ((tenth - 1) * 3);
      expect(input(firstSequence, nowMs)).toBe("accepted");
      expect(input(firstSequence + 1, nowMs)).toBe("accepted");
      expect(input(firstSequence + 2, nowMs)).toBe("accepted");
      expect(input(firstSequence + 3, nowMs)).toBe("rate_limited");
    }
  });

  it("drops duplicate and older sequences without spending rate-limit capacity", () => {
    const gate = new InputGate({ ratePerSecond: 30, burstCapacity: 2 });
    const check = (inputSeq: number) => gate.check({
      userId: "user-1",
      roomId: "room-1",
      inputSeq,
      nowMs: 0
    });

    expect(check(10)).toBe("accepted");
    expect(check(10)).toBe("stale");
    expect(check(9)).toBe("stale");
    expect(check(11)).toBe("accepted");
    expect(check(12)).toBe("rate_limited");
  });

  it("shares the rate limit across a user's rooms while isolating other users", () => {
    const gate = new InputGate({ ratePerSecond: 30, burstCapacity: 1 });

    expect(gate.check({ userId: "same-user", roomId: "room-1", inputSeq: 0, nowMs: 0 })).toBe("accepted");
    expect(gate.check({ userId: "same-user", roomId: "room-2", inputSeq: 0, nowMs: 0 })).toBe("rate_limited");
    expect(gate.check({ userId: "other-user", roomId: "room-2", inputSeq: 0, nowMs: 0 })).toBe("accepted");
  });
});
