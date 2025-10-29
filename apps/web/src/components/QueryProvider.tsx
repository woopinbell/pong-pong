"use client";

import { useEffect, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { SESSION_EXPIRED_EVENT } from "@/lib/api";
import { expireSession, shouldRetryQuery } from "@/lib/query";

export function QueryProvider({ children }: { children: ReactNode }) {
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

  useEffect(() => {
    const onSessionExpired = () => expireSession(client);
    window.addEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
    return () => window.removeEventListener(SESSION_EXPIRED_EVENT, onSessionExpired);
  }, [client]);

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
