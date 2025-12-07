import {
  adminActionsResponseSchema,
  adminUsersResponseSchema,
  apiErrorBodySchema,
  chatResponseSchema,
  dashboardSummarySchema,
  friendResponseSchema,
  friendsResponseSchema,
  guestAuthResponseSchema,
  leaderboardResponseSchema,
  lobbyResponseSchema,
  ownProfileResponseSchema,
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
  type ProfileUpdateBody,
  type PublicUser,
  type SessionUser,
  type TournamentSummary,
  type WsTicketResponse
} from "@pong-pong/shared";

// [INTV:TRAP] NEXT_PUBLIC_ 접두사가 붙은 환경변수만 Next.js가 브라우저로 내려가는 번들에 그대로
// 심어준다(그 외 환경변수는 서버 전용으로 남는다) — 이 API base URL은 브라우저에서 직접 fetch를
// 호출하는 데 쓰이므로 이 접두사가 필요하다. 접두사를 빼먹으면 빌드는 되지만 브라우저 번들에는
// 값이 주입되지 않아 undefined가 되는, 런타임에야 발견되는 흔한 함정(서버 컴포넌트에서는 접두사
// 없이도 동작해서, 서버 전용 코드로 테스트했을 땐 문제가 드러나지 않는다).
const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4000";

export const SESSION_EXPIRED_EVENT = "pong-pong:session-expired";

type FieldErrors = ApiErrorBody["error"]["fieldErrors"];

// [INTV:ARCH] zod 스키마 타입을 직접 가져오는 대신, "parse(value): T 메서드가 있는 것"이라는 최소
// 구조만 요구한다 — apiFetch가 실제로 필요한 건 이 메서드 하나뿐이라, zod에 대한 의존을 타입
// 레벨에서 좁혀둔 것(구조적 타이핑을 이용한 덕 타이핑 — 이 코드베이스 곳곳의 최소 인터페이스
// 패턴을 라이브러리 구조 검증에도 적용).
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

// [INTV:ARCH] 이 프론트엔드의 모든 API 호출이 거치는 단일 관문 — API 서버(다른 오리진/포트)로
// 쿠키를 실어보내도록 credentials: "include"를 강제하고(그래야 세션/게스트 쿠키 기반 인증이
// 동작한다 — 기본값은 same-origin이라 크로스 오리진 API 호출에선 쿠키가 안 실린다), 응답 JSON을
// shared 패키지의 zod 스키마로 검증해서 "서버가 실제로 계약대로 응답했는지"까지 프론트엔드에서
// 다시 한번 보장한다(httpBoundary.ts의 parseOutput이 서버 쪽에서 하는 것과 대칭되는 클라이언트
// 쪽 방어 — 양쪽 다 같은 zod 스키마를 참조하므로 계약이 어긋나면 어느 한쪽에서든 드러난다).
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

export async function getFriends(signal?: AbortSignal): Promise<FriendSummary[]> {
  return (await apiFetch("/friends", friendsResponseSchema, { signal })).friends;
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

export async function getOwnProfile(signal?: AbortSignal): Promise<SessionUser> {
  return (await apiFetch("/profile/me", ownProfileResponseSchema, { signal })).profile;
}

export async function updateOwnProfile(
  input: ProfileUpdateBody,
  signal?: AbortSignal
): Promise<SessionUser> {
  return (await apiFetch("/profile/me", ownProfileResponseSchema, {
    method: "PATCH",
    body: JSON.stringify(input),
    signal
  })).profile;
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

// [INTV:EDGE] 서버가 apiErrorBodySchema 계약대로 에러를 내려줬다면 그 구조화된 정보
// (code/message/requestId)를 그대로 쓰고, 혹시 프록시가 가로챈 HTML 에러 페이지 등 예상 밖의
// 응답이 오더라도(파싱 실패) 최소한의 정보로 ApiError를 만들어 타입은 항상 일관되게 유지한다 —
// 호출부가 항상 ApiError 하나만 처리하면 되고, "서버가 계약대로 응답했는지"에 따라 분기할 필요가
// 없다.
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

// [INTV:ARCH] 세션이 만료됐다는 걸 이 모듈이 직접 어떤 상태 관리자를 호출해서 알리는 대신, 브라우저
// 표준 CustomEvent를 전역(window)에 쏘아 보낸다 — 관심 있는 아무 컴포넌트나 addEventListener로
// 구독하면 되는 느슨한 결합 방식(이 API 클라이언트 모듈이 특정 상태 관리 라이브러리나 라우터를
// import할 필요가 없다 — 이벤트 버스로 의존 방향을 뒤집는 셈).
// [INTV:TRAP] typeof window === "undefined" 체크는 Next.js에서 이 코드가 서버(SSR) 쪽에서도
// 실행될 수 있어서인데, 서버 환경엔 window 자체가 없으므로 그 경우엔 아무것도 하지 않고 조용히
// 넘어간다 — 이 체크 없이 window.dispatchEvent를 바로 호출하면 서버 렌더링 중 "window is not
// defined" 런타임 에러로 페이지 전체가 깨진다.
function signalSessionExpired(): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}
