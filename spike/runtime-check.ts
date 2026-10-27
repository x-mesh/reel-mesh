import { basename } from "node:path";

type Probe = { name: string; ok: boolean };

const probes: Probe[] = [
  { name: "node", ok: process.versions.node.startsWith("26.") },
  { name: "ts-import", ok: basename(import.meta.url) === "runtime-check.ts" },
];

console.log(JSON.stringify(probes));
process.exit(probes.every((p) => p.ok) ? 0 : 1);
