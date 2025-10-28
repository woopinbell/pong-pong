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
  getLeaderboard,
  getLobby,
  getMe,
  getProfile,
  getTournaments
} from "./api";

export const queryKeys = {
  me: () => ["user", "me"] as const,
  lobby: () => ["lobby"] as const,
  dashboard: () => ["dashboard"] as const,
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
  tournamentChange: () => [queryKeys.tournaments()] as const,
  adminStatus: () => [queryKeys.adminUsers(), queryKeys.adminActions()] as const
};

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
