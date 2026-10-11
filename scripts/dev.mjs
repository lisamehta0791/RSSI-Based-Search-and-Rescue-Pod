// Starts the backend (port 4000) and the website (port 8080) together. Ctrl+C stops both.
import { spawn } from "node:child_process";

const procs = [
  { name: "backend", color: 36, cmd: "node src/index.ts", cwd: "backend" },
  { name: "website", color: 35, cmd: "npx vite dev", cwd: "frontend" },
];

const children = procs.map((p) => {
  const child = spawn(p.cmd, { cwd: p.cwd, shell: true, env: process.env });
  const tag = `\x1b[${p.color}m[${p.name}]\x1b[0m `;
  const pipe = (stream, out) => {
    let buf = "";
    stream.on("data", (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const l of lines) out.write(tag + l + "\n");
    });
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on("exit", (code) => {
    console.log(`${tag}stopped (code ${code})`);
    shutdown();
  });
  return child;
});

console.log("\nOpen http://localhost:8080 — Operations console at http://localhost:8080/ops\n");

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  for (const c of children) {
    if (c.exitCode !== null) continue;
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(c.pid), "/T", "/F"]);
    else c.kill("SIGINT");
  }
  setTimeout(() => process.exit(0), 500);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
