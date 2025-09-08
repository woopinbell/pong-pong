"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import type { PublicUser } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { apiFetch, setUserStatus } from "@/lib/api";
import { sampleUsers } from "@/lib/sample";

export default function AdminPage() {
  const [users, setUsers] = useState<PublicUser[]>(sampleUsers);
  const [message, setMessage] = useState("운영자 계정으로 로그인하면 상태 변경이 저장됩니다.");

  useEffect(() => {
    apiFetch<{ users: PublicUser[] }>("/admin/users")
      .then((result) => {
        setUsers(result.users);
        setMessage("사용자 목록을 불러왔습니다.");
      })
      .catch(() => setMessage("운영자 권한이 없어서 샘플 목록을 표시합니다."));
  }, []);

  async function toggleUser(user: PublicUser) {
    try {
      const updated = await setUserStatus(user.id, user.status === "active" ? "banned" : "active");
      setUsers((current) => current.map((item) => (item.id === updated.id ? updated : item)));
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
      <section className="card mt-5 overflow-hidden">
        <div className="grid grid-cols-[1fr_120px_120px_120px] border-b border-line px-5 py-3 text-sm font-black text-muted">
          <span>사용자</span>
          <span className="text-right">점수</span>
          <span className="text-right">상태</span>
          <span className="text-right">조치</span>
        </div>
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
    </AppShell>
  );
}
