import { describe, expect, it } from "vitest";
import { ApiMetrics } from "./observability";

describe("finalization metrics", () => {
  it("counts persisted results and idempotent duplicate results separately", async () => {
    const metrics = new ApiMetrics(() => ({
      onlinePlayers: 0,
      queuedPlayers: 0,
      activeRooms: 0
    }));

    try {
      metrics.recordFinalization("database", "success", true);
      metrics.recordFinalization("database", "success", false);

      const output = await metrics.scrape();

      expect(output).toMatch(
        /pong_pong_api_match_finalizations_total\{persistence="database",outcome="success"\} 2/
      );
      expect(output).toMatch(/pong_pong_api_match_finalization_duplicates_total 1/);
    } finally {
      metrics.close();
    }
  });
});
