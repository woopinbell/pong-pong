"use client";

import { useEffect, useState } from "react";
import { Shield } from "lucide-react";
import type { PublicUser } from "@pong-pong/shared";
import { AppShell } from "@/components/AppShell";
import { apiFetch } from "@/lib/api";
import { sampleUsers } from "@/lib/sample";

export default function AdminPage() {
  const [users, setUsers] = useState<PublicUser[]>(sampleUsers);

  useEffect(() => {
    apiFetch<{ users: PublicUser[] }>("/admin/users").then((result) => setUsers(result.users)).catch(() => undefined);
  }, []);

  return (
    <AppShell>
      <div className="flex items-center gap-3">
        <Shield size={28} className="text-blue-700" />
        <div>
          <h1 className="text-3xl font-black text-ink">관리</h1>
          <p className="mt-2 text-sm font-semibold text-muted">사용자 상태와 최근 운영 조치를 확인합니다.</p>
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
            <button className="focus-ring justify-self-end rounded-lg border border-line px-3 py-2 text-sm font-black text-ink">검토</button>
          </div>
        ))}
      </section>
    </AppShell>
  );
}
