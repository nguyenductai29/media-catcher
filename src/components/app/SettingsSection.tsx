import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export function SettingsSection({
  icon: Icon,
  title,
  children,
}: {
  icon: LucideIcon;
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="panel">
      <h2 className="flex items-center gap-2 border-b border-border px-5 py-3 text-sm font-bold">
        <Icon className="size-4 text-primary" />
        {title}
      </h2>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}
export function SettingsRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 px-5 py-3">
      <span className="text-sm">{label}</span>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}
