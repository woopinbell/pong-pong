import type { LucideIcon } from "lucide-react";

export function StatCard({ label, value, hint, icon: Icon, tone = "blue" }: { label: string; value: string; hint: string; icon: LucideIcon; tone?: "blue" | "green" | "red" | "amber" }) {
  const tones = {
    blue: "bg-blue-50 text-blue-700",
    green: "bg-green-50 text-green-600",
    red: "bg-red-50 text-red-600",
    amber: "bg-amber-50 text-amber-600"
  };
  return (
    <section className="card flex items-center gap-4 p-5">
      <div className={`grid h-14 w-14 place-items-center rounded-full ${tones[tone]}`}>
        {/* [INTV:TRAP] icon: Icon으로 prop을 받아 대문자로 시작하는 지역 변수에 담았다 — JSX는
            소문자 태그(<div>)는 HTML 요소로, 대문자로 시작하는 이름(<Icon>)만 컴포넌트로 해석한다.
            구조분해할 때 icon: Icon처럼 대문자로 리네이밍하지 않고 소문자 icon 그대로 <icon />으로
            쓰면, React가 이를 알 수 없는 HTML 태그로 취급해 렌더링이 깨진다 — prop으로 컴포넌트를
            전달받아 쓸 때 흔히 놓치는 지점. */}
        <Icon size={26} />
      </div>
      <div>
        <p className="text-sm font-bold text-muted">{label}</p>
        <p className="mt-1 text-2xl font-black text-ink">{value}</p>
        <p className="mt-1 text-xs font-bold text-green-600">{hint}</p>
      </div>
    </section>
  );
}
