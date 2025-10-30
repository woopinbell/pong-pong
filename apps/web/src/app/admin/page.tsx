"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Shield } from "lucide-react";
import type { PublicUser } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { setUserStatus } from "@/lib/api";
import {
  adminActionsQueryOptions,
  adminUsersQueryOptions,
  invalidateExactQueries,
  mutationInvalidations
} from "@/lib/query";

export default function AdminPage() {
  const queryClient = useQueryClient();
  const usersQuery = useQuery(adminUsersQueryOptions());
  const actionsQuery = useQuery(adminActionsQueryOptions());
  const users = usersQuery.data ?? [];
  const actions = actionsQuery.data ?? [];
  const [reason, setReason] = useState("운영자 검토");
  const [notice, setNotice] = useState("");
  const message = notice || (usersQuery.isError || actionsQuery.isError
    ? "운영자 권한이 필요합니다."
    : usersQuery.isPending || actionsQuery.isPending
      ? "운영자 계정 정보를 확인하고 있습니다."
      : "사용자 목록과 감사 로그를 불러왔습니다.");
  const statusMutation = useMutation({
    mutationFn: ({ user, nextStatus }: { user: PublicUser; nextStatus: "active" | "banned" }) =>
      setUserStatus(user.id, nextStatus, reason.trim() || "운영자 검토"),
    onSuccess: async (updated) => {
      setNotice(`${updated.displayName} 상태를 ${updated.status === "active" ? "정상" : "정지"}으로 변경했습니다.`);
      await invalidateExactQueries(queryClient, mutationInvalidations.adminStatus());
    },
    onError: () => setNotice("상태 변경은 운영자 권한으로 로그인해야 가능합니다.")
  });

  function toggleUser(user: PublicUser) {
    statusMutation.mutate({
      user,
      nextStatus: user.status === "active" ? "banned" : "active"
    });
  }

  return (
    <AppShell>
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-blue-700" />
        <div>
          <h1 className="text-3xl font-black text-ink">관리</h1>
          <p className="mt-2 text-sm font-semibold text-muted">사용자 상태와 최근 운영 조치를 확인합니다.</p>
          <p className="mt-2 text-sm font-bold text-blue-700">{message}</p>
        </div>
      </div>
      <section className="card mt-5 p-5">
        <label className="text-sm font-black text-ink" htmlFor="admin-reason">조치 사유</label>
        <input
          id="admin-reason"
          className="focus-ring mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm font-semibold"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </section>
      <section className="card mt-5 overflow-hidden">
        <div className="grid grid-cols-[1fr_120px_120px_120px] border-b border-line px-5 py-3 text-sm font-black text-muted">
          <span>사용자</span>
          <span className="text-right">점수</span>
          <span className="text-right">상태</span>
          <span className="text-right">조치</span>
        </div>
        {users.length === 0 ? <p className="px-5 py-4 text-sm font-bold text-muted">표시할 사용자 목록이 없습니다.</p> : null}
        {users.map((user) => (
          <div key={user.id} className="grid grid-cols-[1fr_120px_120px_120px] items-center border-b border-line px-5 py-4 last:border-b-0">
            <div>
              <p className="font-black text-ink">{user.displayName}</p>
              <p className="text-sm font-semibold text-muted">누적 {user.wins}승</p>
            </div>
            <span className="text-right font-black text-green-600">{user.rating}</span>
            <span className="text-right text-sm font-black text-ink">{user.status === "active" ? "정상" : "정지"}</span>
            <button className="focus-ring justify-self-end rounded-lg border border-line px-3 py-2 text-sm font-black text-ink disabled:cursor-not-allowed disabled:bg-slate-50 disabled:text-muted" onClick={() => toggleUser(user)} disabled={statusMutation.isPending}>
              {user.status === "active" ? "정지" : "해제"}
            </button>
          </div>
        ))}
      </section>
      <section className="card mt-5 overflow-hidden">
        <div className="border-b border-line px-5 py-3 text-sm font-black text-muted">감사 로그</div>
        {actions.length === 0 ? <p className="px-5 py-4 text-sm font-bold text-muted">기록된 운영 조치가 없습니다.</p> : null}
        {actions.map((action) => (
          <div key={action.id} className="grid gap-1 border-b border-line px-5 py-4 text-sm last:border-b-0">
            <p className="font-black text-ink">
              {action.target?.displayName ?? "대상 없음"} · {action.action === "ban" ? "정지" : "해제"}
            </p>
            <p className="font-semibold text-muted">{action.reason}</p>
            <p className="text-xs font-bold text-muted">처리자 {action.actor?.displayName ?? "시스템"} · {new Date(action.createdAt).toLocaleString("ko-KR")}</p>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
