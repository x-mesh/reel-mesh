import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const root = dirname(fileURLToPath(import.meta.url));
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const portFlag = process.argv.indexOf("--port");
const port = portFlag === -1 ? 0 : Number(process.argv[portFlag + 1]);

const server = createServer(async (req, res) => {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const relative = normalize(pathname === "/" ? "index.html" : pathname.slice(1));
  if (relative.startsWith("..") || relative === "serve.ts") {
    res.writeHead(404).end();
    return;
  }
  try {
    const body = await readFile(join(root, relative));
    res.writeHead(200, { "content-type": types[extname(relative)] ?? "application/octet-stream" }).end(body);
  } catch {
    res.writeHead(404).end();
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log((server.address() as AddressInfo).port);
});

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
