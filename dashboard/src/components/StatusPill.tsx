import { STATUS_CLASS, STATUS_LABEL, type Status } from "@/lib/status";

export function StatusPill({ status, title }: { status: Status; title?: string }) {
  return (
    <span
      title={title}
      className={
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium " + STATUS_CLASS[status]
      }
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
