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

      // scrape()는 JS 객체가 아니라 Prometheus 텍스트 노출 형식(한 줄에 "지표명{라벨=값,...} 수치")인
      // 평문 문자열을 돌려주므로, 정규식으로 원하는 줄이 그 안에 있는지 직접 매칭해서 확인한다.
      expect(output).toMatch(
        /pong_pong_api_match_finalizations_total\{persistence="database",outcome="success"\} 2/
      );
      expect(output).toMatch(/pong_pong_api_match_finalization_duplicates_total 1/);
    } finally {
      metrics.close();
    }
  });
});
