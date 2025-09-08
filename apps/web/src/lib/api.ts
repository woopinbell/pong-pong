import type { ChatMessage, DashboardSummary, FriendSummary, LeaderboardEntry, MatchSummary, PublicUser, SessionUser, TournamentSummary } from "@pong-pong/shared";
import { sampleChat, sampleDashboard, sampleLeaderboard, sampleTournaments, sampleUsers } from "./sample";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem("pong-pong-token");
}

export function setToken(token: string): void {
  window.localStorage.setItem("pong-pong-token", token);
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers
    }
  });
  if (!response.ok) {
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
  try {
    return (await apiFetch<{ user: SessionUser }>("/me")).user;
  } catch {
    return null;
  }
}

export async function getLobby(): Promise<{ me: SessionUser | null; onlinePlayers: PublicUser[]; chat: ChatMessage[] }> {
  try {
    return await apiFetch("/lobby");
  } catch {
    return { me: null, onlinePlayers: sampleUsers, chat: sampleChat };
  }
}

export async function getDashboard(): Promise<DashboardSummary> {
  try {
    return await apiFetch("/dashboard");
  } catch {
    return sampleDashboard;
  }
}

export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  try {
    return (await apiFetch<{ entries: LeaderboardEntry[] }>("/leaderboard")).entries;
  } catch {
    return sampleLeaderboard;
  }
}

export async function getTournaments(): Promise<TournamentSummary[]> {
  try {
    return (await apiFetch<{ tournaments: TournamentSummary[] }>("/tournaments")).tournaments;
  } catch {
    return sampleTournaments;
  }
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

export async function setUserStatus(id: string, status: "active" | "banned"): Promise<PublicUser> {
  return (await apiFetch<{ user: PublicUser }>(`/admin/users/${id}/status`, {
    method: "PATCH",
    body: JSON.stringify({ status, reason: "operator review" })
  })).user;
}
