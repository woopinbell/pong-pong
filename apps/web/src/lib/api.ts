import type { AdminActionSummary, ChatMessage, DashboardSummary, FriendSummary, LeaderboardEntry, LobbyResponse, MatchSummary, PublicUser, SessionUser, TournamentSummary } from "@pong-pong/shared";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("pong-pong-token");
}

export function setToken(token: string): void {
  window.localStorage.setItem("pong-pong-token", token);
}

export function clearToken(): void {
  window.localStorage.removeItem("pong-pong-token");
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers
  });
  if (!response.ok) {
    if (response.status === 401) clearToken();
    throw new Error((await response.text()) || "요청을 처리하지 못했습니다.");
  }
  return response.json() as Promise<T>;
}

export async function devLogin(handle: string, displayName: string): Promise<SessionUser> {
  const result = await apiFetch<{ user: SessionUser; token: string }>("/auth/dev-login", {
    method: "POST",
    body: JSON.stringify({ handle, displayName })
  });
  setToken(result.token);
  return result.user;
}

export async function getMe(): Promise<SessionUser | null> {
  if (!getToken()) return null;
  try {
    return (await apiFetch<{ user: SessionUser }>("/me")).user;
  } catch {
    return null;
  }
}

export async function getLobby(): Promise<LobbyResponse> {
  return await apiFetch("/lobby");
}

export async function sendLobbyChat(body: string): Promise<ChatMessage> {
  return (await apiFetch<{ message: ChatMessage }>("/chat/lobby", { method: "POST", body: JSON.stringify({ body }) })).message;
}

export async function getDashboard(): Promise<DashboardSummary> {
  return await apiFetch("/dashboard");
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  return (await apiFetch<{ entries: LeaderboardEntry[] }>("/leaderboard")).entries;
}

export async function getTournaments(): Promise<TournamentSummary[]> {
  return (await apiFetch<{ tournaments: TournamentSummary[] }>("/tournaments")).tournaments;
}

export async function createTournament(name: string): Promise<TournamentSummary> {
  return (await apiFetch<{ tournament: TournamentSummary }>("/tournaments", { method: "POST", body: JSON.stringify({ name }) })).tournament;
}

export async function joinTournament(id: string): Promise<TournamentSummary> {
  return (await apiFetch<{ tournament: TournamentSummary }>(`/tournaments/${id}/join`, { method: "POST" })).tournament;
}

export async function getProfile(handle: string): Promise<{ user: PublicUser; recentMatches: MatchSummary[] }> {
  return apiFetch(`/profile/${handle}`);
}

export async function requestFriend(handle: string): Promise<FriendSummary> {
  return (await apiFetch<{ friend: FriendSummary }>("/friends/request", { method: "POST", body: JSON.stringify({ handle }) })).friend;
}

export async function getAdminActions(): Promise<AdminActionSummary[]> {
  return (await apiFetch<{ actions: AdminActionSummary[] }>("/admin/actions")).actions;
}

export async function setUserStatus(id: string, status: "active" | "banned", reason: string): Promise<PublicUser> {
  return (await apiFetch<{ user: PublicUser }>(`/admin/users/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, reason })
  })).user;
}
