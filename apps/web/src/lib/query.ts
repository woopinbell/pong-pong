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

// [INTV:ARCH] TanStack Query의 캐시는 데이터를 "쿼리 키" 배열로 식별한다 — 이 파일은 그 키들을
// 흩어놓지 않고 한 곳에 모아, 어디서 쿼리를 걸든(useQuery 훅이든, 아래 invalidate 호출이든) 같은
// 키 정의를 재사용하게 한다(쿼리 키를 호출부마다 문자열 배열로 직접 쓰면, 오타 하나로 캐시 무효화가
// 조용히 실패하는 문제가 생긴다). as const로 각 키를 리터럴 튜플 타입으로 고정해서, 나중에 이 키로
// 일치하는 쿼리를 찾을 때 타입이 정확히 좁혀진다.
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

// [INTV:ARCH] 어떤 변경(로그인, 로비 채팅 전송 등)이 성공했을 때 "그로 인해 최신이 아니게 됐을"
// 캐시들이 무엇인지를 미리 매핑해둔 표 — 예를 들어 프로필 갱신 하나가 me/프로필/대시보드/친구/
// 순위표 등 여러 화면에 동시에 영향을 줄 수 있으므로, 그 화면들을 다시 불러오도록(invalidate) 한
// 곳에서 관리한다(각 mutation 호출부에서 매번 "이걸 바꾸면 뭐가 같이 바뀌지?"를 다시 판단하는 대신,
// 이 표 하나만 보고 mutationInvalidations.profileUpdate() 같은 식으로 참조).
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

// [INTV:ARCH] queryOptions({...}): 쿼리 키/쿼리 함수/캐시 정책을 하나의 재사용 가능한 객체로
// 묶어주는 TanStack Query 헬퍼 — 컴포넌트의 useQuery(meQueryOptions())에서도, 아래처럼 컴포넌트
// 밖에서 미리 데이터를 채워둘 때도 같은 정의를 쓸 수 있어 두 군데의 타입/설정이 어긋날 일이 없다.
// [INTV:PERF] staleTime은 "이 데이터를 얼마나 오래 신선하다고(다시 안 가져와도 된다고) 볼지"를
// 데이터 성격에 맞춰 다르게 준 것 — 자주 안 변하는 내 프로필은 30초, 실시간성이 중요한 로비는
// 5초처럼(모든 쿼리에 같은 staleTime을 주는 대신, 데이터의 변경 빈도에 맞춰 불필요한 재요청과
// 지나친 캐싱 사이의 균형을 데이터별로 조정).
export const meQueryOptions = () => queryOptions({
  queryKey: queryKeys.me(),
  // [INTV:PERF] queryFn에 넘어오는 signal은 TanStack Query가 이 쿼리의 생명주기(컴포넌트 언마운트,
  // 새 요청으로 대체됨 등)에 맞춰 자동으로 관리해주는 AbortSignal이다 — apiFetch에 그대로 전달해서
  // 불필요해진 요청을 취소한다(ErrorBoundary/useOrderStatusPolling에서 수동으로 하던 AbortController
  // 관리를 TanStack Query가 대신 해주는 셈).
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

// [INTV:TRAP] exact: true를 주는 이유: TanStack Query의 기본 invalidateQueries는 "이 키로 시작하는
// 모든 쿼리"를 대상으로 삼는(접두사 매칭) 동작이라, 정확히 이 키 하나만 무효화하고 싶을 때는 명시적으로
// 꺼줘야 한다 — 예를 들어 queryKeys.profile(handle)처럼 접두사를 공유하는 키 계열이 있다면, exact 없이
// invalidate했을 때 의도하지 않은 다른 프로필 쿼리까지 함께 무효화될 수 있다.
export async function invalidateExactQueries(
  client: QueryClient,
  keys: readonly QueryKey[]
): Promise<void> {
  await Promise.all(keys.map((queryKey) => client.invalidateQueries({ queryKey, exact: true })));
}

// [INTV:EDGE] 401(인증 실패)은 재시도해봐야 결과가 달라지지 않을뿐더러, apiFetch가 401마다 세션
// 만료 이벤트를 쏘므로 재시도하면 그 이벤트도 반복해서 발생한다 — 그래서 401은 즉시 포기하고, 그
// 외 실패만 한 번 재시도한다(재시도로 회복 가능한 일시적 오류와, 재시도해도 똑같이 실패하는
// 오류를 구분하지 않고 무조건 재시도하면 불필요한 부수효과 — 여기선 세션 만료 이벤트 중복 발생 —
// 가 반복된다).
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError && error.status === 401) return false;
  return failureCount < 1;
}

// [INTV:EDGE] 로그아웃/세션 만료 시 로그인 상태에 종속적인 캐시를 전부 지운다. 다만 그 쿼리가 "지금
// 한창 fetch 중"이라면 즉시 지우지 않고 setTimeout(..., 0)으로 다음 이벤트 루프 틱으로 미룬다 —
// 진행 중인 요청의 상태를 바로 걷어내면 TanStack Query 내부 상태와 어긋날 수 있어서(진행 중인
// fetch가 완료되면서 이미 지워진 쿼리 캐시에 결과를 쓰려는 시도), 그 fetch가 이번 틱에서 일단락되게
// 한 뒤 지운다.
// [INTV:ARCH] 마지막 줄의 setQueryData(..., null)은 네트워크 요청 없이 캐시 값을 즉시 "로그아웃됨"
// 으로 덮어써서, 화면이 다음 새로고침을 기다리지 않고 바로 반영되게 한다(TanStack Query의 optimistic
// update와 같은 기법 — 서버 왕복 없이 캐시를 직접 조작해 즉각적인 UI 반응을 얻는다).
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
