import { useEffect, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import {
  FIRE_HEX,
  STATUS_HEX,
  STATUS_LABEL,
  TEAM_STATUS_HEX,
  TEAM_STATUS_LABEL,
  TIER_HEX,
  TIER_LABEL,
  type TargetStatus,
  type TeamStatus,
  type Tier,
} from "@/lib/domain";

export function Btn({
  tone = "default",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "default" | "primary" | "danger" | "active" | "ghost";
  size?: "sm" | "md" | "lg";
}) {
  const tones = {
    default: "border border-input bg-card hover:bg-secondary",
    primary: "bg-primary text-primary-foreground hover:opacity-90 shadow-sm",
    danger: "bg-destructive text-destructive-foreground hover:opacity-90 shadow-sm",
    active: "border-2 border-primary bg-accent text-accent-foreground",
    ghost: "hover:bg-secondary",
  };
  const sizes = {
    sm: "h-8 px-2.5 text-sm",
    md: "h-10 px-3.5 text-sm",
    lg: "h-12 px-5 text-base",
  };
  return (
    <button
      type="button"
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg font-medium whitespace-nowrap transition disabled:pointer-events-none disabled:opacity-40 ${tones[tone]} ${sizes[size]} ${className}`}
      {...rest}
    />
  );
}

function Pill({ color, solid, children }: { color: string; solid?: boolean; children: ReactNode }) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold whitespace-nowrap"
      style={
        solid
          ? { backgroundColor: color, color: "white" }
          : { color, backgroundColor: `color-mix(in oklab, ${color} 14%, transparent)` }
      }
    >
      {children}
    </span>
  );
}

export function TierBadge({ tier }: { tier: Tier }) {
  return (
    <Pill color={TIER_HEX[tier]} solid>
      {TIER_LABEL[tier]} priority
    </Pill>
  );
}

export function FireBadge() {
  return <Pill color={FIRE_HEX}>🔥 Fire nearby</Pill>;
}

export function SmokeBadge() {
  return <Pill color={FIRE_HEX}>💨 Smoke / gas nearby</Pill>;
}

export function StatusBadge({ status }: { status: TargetStatus }) {
  return <Pill color={STATUS_HEX[status]}>{STATUS_LABEL[status]}</Pill>;
}

export function TeamStatusBadge({ status }: { status: TeamStatus }) {
  return (
    <Pill color={TEAM_STATUS_HEX[status]} solid={status === "SOS"}>
      {TEAM_STATUS_LABEL[status]}
    </Pill>
  );
}

export function Stat({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-background/60 px-3 py-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="truncate text-base font-semibold" style={tone ? { color: tone } : undefined}>
        {value}
      </p>
    </div>
  );
}

/** A LED drawn like the real one on the breadboard. */
export function Led({ on, color, label }: { on: boolean | null; color: string; label: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5">
      <span
        className="h-6 w-6 rounded-full border-2 transition"
        style={{
          borderColor: color,
          backgroundColor: on ? color : "transparent",
          boxShadow: on ? `0 0 14px ${color}` : undefined,
          opacity: on === null ? 0.3 : 1,
        }}
      />
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
    </div>
  );
}

/**
 * Text input that keeps its own draft and saves on blur / Enter, so live updates
 * don't overwrite what the operator is typing.
 */
export function SaveInput({
  value,
  onSave,
  placeholder,
  multiline = false,
  className = "",
}: {
  value: string;
  onSave: (v: string) => void;
  placeholder?: string;
  multiline?: boolean;
  className?: string;
}) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setDraft(value);
  }, [value, focused]);
  const commit = () => {
    setFocused(false);
    if (draft !== value) onSave(draft);
  };
  const cls = `w-full rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20 ${className}`;
  return multiline ? (
    <textarea
      rows={2}
      value={draft}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      className={cls}
    />
  ) : (
    <input
      value={draft}
      placeholder={placeholder}
      onFocus={() => setFocused(true)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
      className={cls}
    />
  );
}

export const selectCls =
  "h-10 rounded-lg border border-input bg-card px-2.5 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";

export const inputCls =
  "h-10 w-full rounded-lg border border-input bg-card px-3 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary/20";
