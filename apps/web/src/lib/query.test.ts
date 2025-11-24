import { QueryClient, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "./api";
import {
  expireSession,
  friendsQueryOptions,
  invalidateExactQueries,
  mutationInvalidations,
  ownProfileQueryOptions,
  queryKeys,
  shouldRetryQuery
} from "./query";

describe("query key contract", () => {
  it("keeps screen data in stable, scoped keys", () => {
    expect(queryKeys.me()).toEqual(["user", "me"]);
    expect(queryKeys.lobby()).toEqual(["lobby"]);
    expect(queryKeys.dashboard()).toEqual(["dashboard"]);
    expect(queryKeys.ownProfile()).toEqual(["user", "profile"]);
    expect(queryKeys.profile("pong-master")).toEqual(["profiles", "pong-master"]);
    expect(queryKeys.leaderboard()).toEqual(["leaderboard"]);
    expect(queryKeys.friends()).toEqual(["friends"]);
    expect(queryKeys.tournaments()).toEqual(["tournaments"]);
    expect(queryKeys.adminUsers()).toEqual(["admin", "users"]);
    expect(queryKeys.adminActions()).toEqual(["admin", "actions"]);
  });

  it("invalidates only the data affected by each mutation", () => {
    expect(mutationInvalidations.login()).toEqual([
      queryKeys.me(),
      queryKeys.lobby()
    ]);
    expect(mutationInvalidations.lobbyChat()).toEqual([queryKeys.lobby()]);
    expect(mutationInvalidations.friendRequest()).toEqual([queryKeys.friends()]);
    expect(mutationInvalidations.profileUpdate("pong-master")).toEqual([
      queryKeys.me(),
      queryKeys.ownProfile(),
      queryKeys.profile("pong-master"),
      queryKeys.lobby(),
      queryKeys.dashboard(),
      queryKeys.friends(),
      queryKeys.leaderboard(),
      queryKeys.tournaments(),
      queryKeys.adminUsers(),
      queryKeys.adminActions()
    ]);
    expect(mutationInvalidations.tournamentChange()).toEqual([
      queryKeys.tournaments()
    ]);
    expect(mutationInvalidations.adminStatus()).toEqual([
      queryKeys.adminUsers(),
      queryKeys.adminActions()
    ]);
  });

  it("connects private profile and friend reads to their scoped cache keys", () => {
    expect(ownProfileQueryOptions().queryKey).toEqual(queryKeys.ownProfile());
    expect(friendsQueryOptions().queryKey).toEqual(queryKeys.friends());
  });

  it("marks exact mutation keys stale without touching adjacent caches", async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.adminUsers(), [{ id: "user-1" }]);
    client.setQueryData(queryKeys.adminActions(), [{ id: "action-1" }]);
    client.setQueryData(queryKeys.leaderboard(), [{ rank: 1 }]);

    await invalidateExactQueries(client, mutationInvalidations.adminStatus());

    expect(client.getQueryState(queryKeys.adminUsers())?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.adminActions())?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.leaderboard())?.isInvalidated).toBe(false);
  });
});

describe("session expiration", () => {
  it("does not retry an expired cookie session", () => {
    const unauthorized = new ApiError(401, "UNAUTHORIZED", "로그인이 필요합니다.", "req-401");

    expect(shouldRetryQuery(0, unauthorized)).toBe(false);
    expect(shouldRetryQuery(0, new Error("temporary"))).toBe(true);
    expect(shouldRetryQuery(1, new Error("temporary"))).toBe(false);
  });

  it("drops session-scoped data while keeping public caches", () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.me(), { id: "user-1" });
    client.setQueryData(queryKeys.lobby(), { me: { id: "user-1" } });
    client.setQueryData(queryKeys.dashboard(), { wins: 2 });
    client.setQueryData(queryKeys.ownProfile(), { id: "user-1" });
    client.setQueryData(queryKeys.friends(), [{ id: "friend-1" }]);
    client.setQueryData(queryKeys.adminUsers(), [{ id: "user-1" }]);
    client.setQueryData(queryKeys.adminActions(), [{ id: "action-1" }]);
    client.setQueryData(queryKeys.leaderboard(), [{ rank: 1 }]);
    client.setQueryData(queryKeys.profile("pong-master"), { rating: 1_000 });
    client.setQueryData(queryKeys.tournaments(), [{ id: "tournament-1" }]);

    expireSession(client);

    expect(client.getQueryData(queryKeys.me())).toBeNull();
    expect(client.getQueryData(queryKeys.lobby())).toBeUndefined();
    expect(client.getQueryData(queryKeys.dashboard())).toBeUndefined();
    expect(client.getQueryData(queryKeys.ownProfile())).toBeUndefined();
    expect(client.getQueryData(queryKeys.friends())).toBeUndefined();
    expect(client.getQueryData(queryKeys.adminUsers())).toBeUndefined();
    expect(client.getQueryData(queryKeys.adminActions())).toBeUndefined();
    expect(client.getQueryData(queryKeys.leaderboard())).toEqual([{ rank: 1 }]);
    expect(client.getQueryData(queryKeys.profile("pong-master"))).toEqual({ rating: 1_000 });
    expect(client.getQueryData(queryKeys.tournaments())).toEqual([{ id: "tournament-1" }]);
  });

  it("lets an active unauthorized query settle instead of leaving it pending", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } }
    });
    const observer = new QueryObserver(client, {
      queryKey: queryKeys.adminUsers(),
      queryFn: async () => {
        expireSession(client);
        throw new Error("unauthorized");
      }
    });
    const unsubscribe = observer.subscribe(() => undefined);

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(observer.getCurrentResult()).toMatchObject({
      status: "error",
      fetchStatus: "idle"
    });
    unsubscribe();
  });
});
