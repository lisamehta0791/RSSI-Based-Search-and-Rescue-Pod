import type { LinkState } from "@/hooks/useLiveState";

export function Connecting({ link }: { link: LinkState }) {
  return (
    <div className="flex min-h-screen items-center justify-center p-6 text-center text-xs text-muted-foreground">
      {link === "lost" ? (
        <p>
          Cannot reach the coordination server.
          <br />
          Run <code className="text-foreground">npm run dev</code> in the project folder.
        </p>
      ) : (
        <p>CONNECTING TO COORDINATION SERVER…</p>
      )}
    </div>
  );
}
