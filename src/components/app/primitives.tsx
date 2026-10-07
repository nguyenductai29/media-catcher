import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";
import type { StatusKey } from "@/lib/mock";
import type { DownloadStatus, DriveUploadStatus } from "../../../shared/models";

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6", className)} aria-hidden>
      <rect
        x="2"
        y="2"
        width="28"
        height="28"
        rx="8"
        className="fill-primary/15 stroke-primary"
        strokeWidth="1.5"
      />
      <path
        d="M8 9h16M8 23h16"
        className="stroke-primary/50"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M13 12.5v7l6-3.5z" className="fill-primary" />
    </svg>
  );
}

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      <LogoMark />
      {!compact && (
        <span className="text-sm font-bold tracking-tight">
          Media<span className="text-primary">Vault</span>
        </span>
      )}
    </div>
  );
}

const tone: Record<StatusKey | DownloadStatus | DriveUploadStatus, string> = {
  preparing: "text-info bg-info/10 ring-info/25",
  finalizing: "text-info bg-info/10 ring-info/25",
  analyzing: "text-info bg-info/10 ring-info/25",
  processing: "text-info bg-info/10 ring-info/25",
  cancelled: "text-muted-foreground bg-muted ring-border",
  downloading: "text-primary bg-primary/10 ring-primary/25",
  uploading: "text-primary bg-primary/10 ring-primary/25",
  scanning: "text-info bg-info/10 ring-info/25",
  detected: "text-info bg-info/10 ring-info/25",
  queued: "text-muted-foreground bg-muted ring-border",
  localOnly: "text-muted-foreground bg-muted ring-border",
  paused: "text-warning bg-warning/10 ring-warning/25",
  completed: "text-success bg-success/10 ring-success/25",
  uploaded: "text-success bg-success/10 ring-success/25",
  failed: "text-destructive bg-destructive/10 ring-destructive/25",
};

export function StatusBadge({
  status,
  label,
}: {
  status: StatusKey | DownloadStatus | DriveUploadStatus;
  label?: string;
}) {
  const { t } = useT();
  const live = status === "downloading" || status === "uploading" || status === "scanning";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset",
        tone[status],
      )}
    >
      <span className={cn("size-1.5 rounded-full bg-current", live && "animate-pulse")} />
      {label ?? t(`status.${status}`)}
    </span>
  );
}

export function Bar({
  value,
  status = "downloading",
  className,
}: {
  value: number;
  status?: StatusKey | DownloadStatus | DriveUploadStatus;
  className?: string;
}) {
  const color =
    status === "failed"
      ? "bg-destructive"
      : status === "paused"
        ? "bg-warning"
        : status === "completed" || status === "uploaded"
          ? "bg-success"
          : status === "queued"
            ? "bg-muted-foreground/40"
            : "bg-primary";
  return (
    <div className={cn("h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}>
      <div
        className={cn("h-full rounded-full transition-all duration-500", color)}
        style={{ width: `${Math.min(100, value)}%` }}
      />
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="mb-4 grid size-14 place-items-center rounded-2xl border border-border bg-surface-2">
        <Icon className="size-6 text-muted-foreground" strokeWidth={1.5} />
      </div>
      <p className="text-sm font-semibold">{title}</p>
      {hint && <p className="mt-1 max-w-xs text-xs text-muted-foreground">{hint}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function Segmented<T extends string>({
  items,
  value,
  onChange,
  className,
}: {
  items: { value: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "inline-flex flex-wrap gap-1 rounded-lg border border-border bg-chrome p-1",
        className,
      )}
    >
      {items.map((i) => (
        <button
          key={i.value}
          onClick={() => onChange(i.value)}
          className={cn(
            "whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors",
            value === i.value
              ? "bg-surface-2 text-foreground shadow-sm ring-1 ring-border"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          {i.label}
          {i.count !== undefined && (
            <span className="ml-1.5 text-[10px] text-muted-foreground">{i.count}</span>
          )}
        </button>
      ))}
    </div>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-xl font-bold tracking-tight">{title}</h1>
        {subtitle && <div className="mt-1 text-xs text-muted-foreground">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function IconBtn({
  icon: Icon,
  label,
  onClick,
  active,
  className,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  active?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "grid size-8 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground disabled:pointer-events-none disabled:opacity-40",
        active && "text-primary",
        className,
      )}
    >
      <Icon className="size-4" />
    </button>
  );
}

export function Thumb({ src, className }: { src: string; className?: string }) {
  return (
    <img
      src={src}
      alt=""
      loading="lazy"
      width={1088}
      height={608}
      className={cn("aspect-video rounded-md object-cover", className)}
    />
  );
}
