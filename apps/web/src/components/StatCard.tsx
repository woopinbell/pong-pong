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
