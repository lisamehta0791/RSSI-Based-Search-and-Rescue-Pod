import { toast } from "sonner";
import type { AreaKind, LatLng, PodLocationMode, TargetStatus } from "@/lib/domain";

/**
 * Thin client for the coordination server. All calls go to /api on the same origin; the
 * Vite dev server proxies them to ../server (see vite.config.ts).
 */
async function call<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  actor = "operator",
): Promise<T> {
  try {
    const res = await fetch(`/api${path}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Actor": actor },
      body: body === undefined ? null : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    return data as T;
  } catch (e) {
    toast.error(`Server: ${(e as Error).message}`);
    throw e;
  }
}

export const api = {
  updatePod: (
    id: string,
    patch: {
      name?: string;
      locationMode?: PodLocationMode;
      manualPosition?: LatLng | null;
      carrierTeamId?: string | null;
    },
  ) => call("PATCH", `/pods/${id}`, patch),

  deletePod: (id: string) => call("DELETE", `/pods/${id}`),
  clearTrail: (id: string) => call("POST", `/pods/${id}/trail/clear`),
  loadSampleData: () => call("POST", "/demo"),

  createTeam: (name: string, members: string) =>
    call<{ id: string }>("POST", "/teams", { name, members }),
  updateTeam: (id: string, patch: { name?: string; members?: string }) =>
    call("PATCH", `/teams/${id}`, patch),
  deleteTeam: (id: string) => call("DELETE", `/teams/${id}`),
  teamPosition: (
    id: string,
    pos: LatLng & { accuracyM: number | null; source: "gps" | "manual" },
  ) => call("POST", `/teams/${id}/position`, pos, id),
  sos: (id: string, active: boolean, actor: string) =>
    call("POST", `/teams/${id}/sos`, { active }, actor),

  updateTarget: (
    kind: "detection" | "area",
    id: string,
    patch: {
      status?: TargetStatus;
      assignedTeamId?: string | null;
      label?: string;
      notes?: string;
      position?: LatLng;
      radiusM?: number;
    },
    actor = "operator",
  ) => call("PATCH", `/${kind === "detection" ? "detections" : "areas"}/${id}`, patch, actor),

  createArea: (kind: AreaKind, center: LatLng, radiusM: number, label: string) =>
    call<{ id: string }>("POST", "/areas", { kind, center, radiusM, label }),
  deleteArea: (id: string) => call("DELETE", `/areas/${id}`),

  updateSite: (patch: { name?: string; center?: LatLng; zoom?: number }) =>
    call("PATCH", "/site", patch),
  resetSession: () => call("POST", "/session/reset"),
};
