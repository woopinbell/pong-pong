import {
  adminActionsResponseSchema,
  adminUsersResponseSchema,
  apiErrorBodySchema,
  chatResponseSchema,
  dashboardSummarySchema,
  friendResponseSchema,
  guestAuthResponseSchema,
  leaderboardResponseSchema,
  lobbyResponseSchema,
  profileResponseSchema,
  publicUserResponseSchema,
  tournamentResponseSchema,
  tournamentsResponseSchema,
  userResponseSchema,
  wsTicketResponseSchema,
  type AdminActionSummary,
  type ApiErrorBody,
  type ChatMessage,
  type DashboardSummary,
  type FriendSummary,
  type GuestAuthResponse,
  type LeaderboardEntry,
  type LobbyResponse,
  type MatchSummary,
  type PublicUser,
  type SessionUser,
  type TournamentSummary,
  type WsTicketResponse
} from "@pong-pong/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export const SESSION_EXPIRED_EVENT = "pong-pong:session-expired";

type FieldErrors = ApiErrorBody["error"]["fieldErrors"];

type ResponseSchema<T> = {
  parse(value: unknown): T;
};

export class ApiError extends Error {
  override readonly name = "ApiError";

  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly requestId: string,
    readonly fieldErrors?: FieldErrors
  ) {
    super(message);
  }
}

export async function apiFetch<T>(
  path: string,
  schema: ResponseSchema<T>,
  init: RequestInit = {}
): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers
  });
  if (!response.ok) {
    const error = await responseError(response);
    if (response.status === 401) signalSessionExpired();
    throw error;
  }
  return schema.parse(await response.json());
}

export async function devLogin(
  handle: string,
  displayName: string,
  signal?: AbortSignal
): Promise<SessionUser> {
  const result = await apiFetch("/auth/dev-login", userResponseSchema, {
    method: "POST",
    body: JSON.stringify({ handle, displayName }),
    signal
  });
  return result.user;
}

export async function guestLogin(signal?: AbortSignal): Promise<GuestAuthResponse> {
  return apiFetch("/auth/guest", guestAuthResponseSchema, {
    method: "POST",
    signal
  });
}

export async function getMe(signal?: AbortSignal): Promise<SessionUser | null> {
  try {
    return (await apiFetch("/me", userResponseSchema, { signal })).user;
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return null;
    throw error;
  }
}

export async function getLobby(signal?: AbortSignal): Promise<LobbyResponse> {
  return apiFetch("/lobby", lobbyResponseSchema, { signal });
}

export async function sendLobbyChat(body: string, signal?: AbortSignal): Promise<ChatMessage> {
  return (await apiFetch("/chat/lobby", chatResponseSchema, {
    method: "POST",
    body: JSON.stringify({ body }),
    signal
  })).message;
}

export async function getDashboard(signal?: AbortSignal): Promise<DashboardSummary> {
  return apiFetch("/dashboard", dashboardSummarySchema, { signal });
}

export async function getLeaderboard(signal?: AbortSignal): Promise<LeaderboardEntry[]> {
  return (await apiFetch("/leaderboard", leaderboardResponseSchema, { signal })).entries;
}

export async function getTournaments(signal?: AbortSignal): Promise<TournamentSummary[]> {
  return (await apiFetch("/tournaments", tournamentsResponseSchema, { signal })).tournaments;
}

export async function createTournament(name: string, signal?: AbortSignal): Promise<TournamentSummary> {
  return (await apiFetch("/tournaments", tournamentResponseSchema, {
    method: "POST",
    body: JSON.stringify({ name }),
    signal
  })).tournament;
}

export async function joinTournament(id: string, signal?: AbortSignal): Promise<TournamentSummary> {
  return (await apiFetch(`/tournaments/${id}/join`, tournamentResponseSchema, {
    method: "POST",
    signal
  })).tournament;
}

export async function getProfile(
  handle: string,
  signal?: AbortSignal
): Promise<{ user: PublicUser; recentMatches: MatchSummary[] }> {
  return apiFetch(`/profile/${handle}`, profileResponseSchema, { signal });
}

export async function requestFriend(handle: string, signal?: AbortSignal): Promise<FriendSummary> {
  return (await apiFetch("/friends/request", friendResponseSchema, {
    method: "POST",
    body: JSON.stringify({ handle }),
    signal
  })).friend;
}

export async function getAdminUsers(signal?: AbortSignal): Promise<PublicUser[]> {
  return (await apiFetch("/admin/users", adminUsersResponseSchema, { signal })).users;
}

export async function getAdminActions(signal?: AbortSignal): Promise<AdminActionSummary[]> {
  return (await apiFetch("/admin/actions", adminActionsResponseSchema, { signal })).actions;
}

export async function setUserStatus(
  id: string,
  status: "active" | "banned",
  reason: string,
  signal?: AbortSignal
): Promise<PublicUser> {
  return (await apiFetch(`/admin/users/${id}/status`, publicUserResponseSchema, {
    method: "PATCH",
    body: JSON.stringify({ status, reason }),
    signal
  })).user;
}

export async function requestWsTicket(signal?: AbortSignal): Promise<WsTicketResponse> {
  return apiFetch("/auth/ws-ticket", wsTicketResponseSchema, { method: "POST", signal });
}

async function responseError(response: Response): Promise<ApiError> {
  try {
    const parsed = apiErrorBodySchema.safeParse(await response.json());
    if (parsed.success) {
      const { code, message, requestId, fieldErrors } = parsed.data.error;
      return new ApiError(response.status, code, message, requestId, fieldErrors);
    }
  } catch {
    // The fallback below keeps network-facing failures typed even if the server response is malformed.
  }

  return new ApiError(
    response.status,
    "HTTP_ERROR",
    response.statusText || "요청을 처리하지 못했습니다.",
    response.headers.get("x-request-id") ?? "unknown"
  );
}

function signalSessionExpired(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
