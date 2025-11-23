import {
  queryOptions,
  type QueryClient,
  type QueryKey
} from "@tanstack/react-query";
import {
  ApiError,
  getAdminActions,
  getAdminUsers,
  getDashboard,
  getFriends,
  getLeaderboard,
  getLobby,
  getMe,
  getOwnProfile,
  getProfile,
  getTournaments
} from "./api";

export const queryKeys = {
  me: () => ["user", "me"] as const,
  lobby: () => ["lobby"] as const,
  dashboard: () => ["dashboard"] as const,
  ownProfile: () => ["user", "profile"] as const,
  profile: (handle: string) => ["profiles", handle] as const,
  leaderboard: () => ["leaderboard"] as const,
  friends: () => ["friends"] as const,
  tournaments: () => ["tournaments"] as const,
  adminUsers: () => ["admin", "users"] as const,
  adminActions: () => ["admin", "actions"] as const
};

export const mutationInvalidations = {
  login: () => [queryKeys.me(), queryKeys.lobby()] as const,
  lobbyChat: () => [queryKeys.lobby()] as const,
  friendRequest: () => [queryKeys.friends()] as const,
  profileUpdate: (handle: string) => [
    queryKeys.me(),
    queryKeys.ownProfile(),
    queryKeys.profile(handle),
    queryKeys.lobby(),
    queryKeys.dashboard(),
    queryKeys.friends(),
    queryKeys.leaderboard(),
    queryKeys.tournaments(),
    queryKeys.adminUsers(),
    queryKeys.adminActions()
  ] as const,
  tournamentChange: () => [queryKeys.tournaments()] as const,
  adminStatus: () => [queryKeys.adminUsers(), queryKeys.adminActions()] as const
};

export const meQueryOptions = () => queryOptions({
  queryKey: queryKeys.me(),
  queryFn: ({ signal }) => getMe(signal),
  staleTime: 30_000
});

export const lobbyQueryOptions = () => queryOptions({
  queryKey: queryKeys.lobby(),
  queryFn: ({ signal }) => getLobby(signal),
  staleTime: 5_000
});

export const dashboardQueryOptions = () => queryOptions({
  queryKey: queryKeys.dashboard(),
  queryFn: ({ signal }) => getDashboard(signal),
  staleTime: 10_000
});

export const ownProfileQueryOptions = () => queryOptions({
  queryKey: queryKeys.ownProfile(),
  queryFn: ({ signal }) => getOwnProfile(signal),
  staleTime: 30_000
});

export const profileQueryOptions = (handle: string) => queryOptions({
  queryKey: queryKeys.profile(handle),
  queryFn: ({ signal }) => getProfile(handle, signal),
  staleTime: 30_000
});

export const friendsQueryOptions = () => queryOptions({
  queryKey: queryKeys.friends(),
  queryFn: ({ signal }) => getFriends(signal),
  staleTime: 10_000
});

export const leaderboardQueryOptions = () => queryOptions({
  queryKey: queryKeys.leaderboard(),
  queryFn: ({ signal }) => getLeaderboard(signal),
  staleTime: 15_000
});

export const tournamentsQueryOptions = () => queryOptions({
  queryKey: queryKeys.tournaments(),
  queryFn: ({ signal }) => getTournaments(signal),
  staleTime: 10_000
});

export const adminUsersQueryOptions = () => queryOptions({
  queryKey: queryKeys.adminUsers(),
  queryFn: ({ signal }) => getAdminUsers(signal),
  staleTime: 5_000
});

export const adminActionsQueryOptions = () => queryOptions({
  queryKey: queryKeys.adminActions(),
  queryFn: ({ signal }) => getAdminActions(signal),
  staleTime: 5_000
});

export async function invalidateExactQueries(
  client: QueryClient,
  keys: readonly QueryKey[]
): Promise<void> {
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey, exact: true })));
}

export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) return false;
  return failureCount < 1;
}

export function expireSession(client: QueryClient): void {
  const sessionScopedKeys = [
    queryKeys.lobby(),
    queryKeys.dashboard(),
    queryKeys.ownProfile(),
    queryKeys.friends(),
    queryKeys.adminUsers(),
    queryKeys.adminActions()
  ] as const;

  for (const queryKey of sessionScopedKeys) {
    if (client.getQueryState(queryKey)?.fetchStatus === "fetching") {
      setTimeout(() => client.removeQueries({ queryKey, exact: true }), 0);
    } else {
      client.removeQueries({ queryKey, exact: true });
    }
  }
  client.setQueryData(queryKeys.me(), null);
}
