import { STATUS_LABEL, type Status } from "@/lib/status";

const DOT: Record<Status, string> = {
  running: "bg-accent dot-live",
  stopped: "bg-muted",
  empty: "bg-info",
  blocked: "bg-danger",
  offline: "bg-warn",
};

const TEXT: Record<Status, string> = {
  running: "text-accent",
  stopped: "text-muted",
  empty: "text-info",
  blocked: "text-danger",
  offline: "text-warn",
};

export function StatusPill({ status, title }: { status: Status; title?: string }) {
  return (
    <span title={title} className={"inline-flex items-center gap-1.5 text-xs font-medium " + TEXT[status]}>
      <span className={"inline-block h-2 w-2 rounded-full " + DOT[status]} />
      {STATUS_LABEL[status]}
    </span>
  );
}
