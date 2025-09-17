"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import type { AdminActionSummary, PublicUser } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { apiFetch, getAdminActions, setUserStatus } from "@/lib/api";

export default function AdminPage() {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [actions, setActions] = useState<AdminActionSummary[]>([]);
  const [reason, setReason] = useState("운영자 검토");
  const [message, setMessage] = useState("운영자 계정으로 로그인하면 상태 변경이 저장됩니다.");

  useEffect(() => {
    Promise.all([apiFetch<{ users: PublicUser[] }>("/admin/users"), getAdminActions()])
      .then(([result, actionItems]) => {
        setUsers(result.users);
        setActions(actionItems);
        setMessage("사용자 목록과 감사 로그를 불러왔습니다.");
      })
      .catch(() => setMessage("운영자 권한이 필요합니다."));
  }, []);

  async function toggleUser(user: PublicUser) {
    try {
      const updated = await setUserStatus(user.id, user.status === "active" ? "banned" : "active", reason.trim() || "운영자 검토");
      setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      setActions(await getAdminActions());
      setMessage(`${updated.displayName} 상태를 ${updated.status === "active" ? "정상" : "정지"}으로 변경했습니다.`);
    } catch {
      setMessage("상태 변경은 운영자 권한으로 로그인해야 가능합니다.");
    }
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
            <button className="focus-ring justify-self-end rounded-lg border border-line px-3 py-2 text-sm font-black text-ink" onClick={() => toggleUser(user)}>
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
