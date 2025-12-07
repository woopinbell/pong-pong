"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SESSION_EXPIRED_EVENT } from "@/lib/api";
import { expireSession, shouldRetryQuery } from "@/lib/query";

export function QueryProvider({ children }: { children: ReactNode }) {
  // [INTV:PERF] useState(() => new QueryClient(...)): useState에 값 대신 함수를 넘기면 "첫
  // 렌더링에서 딱 한 번만" 그 함수를 실행해 초기값을 만든다(지연 초기화) — checkout/page.tsx의
  // useState(() => crypto.randomUUID())와 같은 패턴. new QueryClient(...)를 직접 넘기면 리렌더링마다
  // 매번 새 인스턴스를 만들어버리는데(실제로 쓰이는 건 처음 것 하나뿐인데도, useState는 초기값
  // 인자를 매 렌더마다 평가는 하고 버릴 뿐이다), 함수로 감싸면 그 낭비를 막는다.
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: shouldRetryQuery,
        refetchOnWindowFocus: true
      },
      mutations: {
        retry: false
      }
    }
  }));

  // [INTV:ARCH] api.ts가 401 응답마다 window에 쏘는 커스텀 이벤트를 여기서 구독해 query.ts의
  // expireSession으로 캐시를 정리한다 — 이 컴포넌트가 트리 최상단에서 한 번만 구독을 걸어두면
  // 되므로, 여기가 그 이벤트의 유일한 소비처(api.ts의 signalSessionExpired가 쏘는 이벤트와 이
  // 구독이 느슨하게 결합된 발행-구독 쌍을 이룬다).
  useEffect(() => {
    const onSessionExpired = () => expireSession(client);
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, [client]);

  // [INTV:ARCH] QueryClientProvider: React Context Provider — 이 아래 트리 어디서든(children으로
  // 감싸인 모든 컴포넌트) props로 client를 일일이 넘기지 않아도 useQuery/useMutation 훅이 이
  // client를 찾아 쓸 수 있게 해준다(useQueryClient()는 반드시 이 Provider 안에서만 호출해야 하고,
  // 밖에서 쓰면 client를 못 찾아 에러가 난다).
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
