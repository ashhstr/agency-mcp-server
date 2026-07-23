#!/usr/bin/env node
import { execSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createIndexState } from "./registry.js";
import { registerHandlers } from "./tools.js";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf-8"),
);

const REPO_URL =
  process.env.AGENCY_REPO_URL ||
  "https://github.com/msitarzewski/agency-agents.git";
const CACHE_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), ".cache"),
  "agency-mcp-server",
);
const DEFAULT_AGENTS_PATH = join(CACHE_DIR, "agency-agents");
const AUTO_UPDATE = process.env.AGENCY_AUTO_UPDATE !== "false";
const UPDATE_INTERVAL_MS =
  Number(process.env.AGENCY_UPDATE_INTERVAL || 24) * 60 * 60 * 1000;
const STAMP_FILE = join(CACHE_DIR, ".last-pull");

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function lastPullTimestamp(): number | null {
  try {
    return Number(readFileSync(STAMP_FILE, "utf-8"));
  } catch {
    return null;
  }
}

function shouldPull(): boolean {
  if (!AUTO_UPDATE) return false;
  const last = lastPullTimestamp();
  return last === null || Date.now() - last >= UPDATE_INTERVAL_MS;
}

function markPulled(): void {
  writeFileSync(STAMP_FILE, String(Date.now()));
}

function pullRepo(): void {
  execSync("git pull --ff-only", {
    cwd: DEFAULT_AGENTS_PATH,
    stdio: "ignore",
    timeout: 15_000,
  });
  markPulled();
}

function ensureAgentsPath(): string {
  if (process.env.AGENCY_AGENTS_PATH) {
    const p = process.env.AGENCY_AGENTS_PATH;
    if (!isDirectory(p)) {
      console.error(
        `[agency] Fatal: AGENCY_AGENTS_PATH is not a valid directory: ${p}`,
      );
      process.exit(1);
    }
    return p;
  }

  if (existsSync(join(DEFAULT_AGENTS_PATH, ".git"))) {
    if (shouldPull()) {
      console.error(
        `[agency] Updating agent templates in ${DEFAULT_AGENTS_PATH}`,
      );
      try {
        pullRepo();
      } catch {
        console.error(
          "[agency] Warning: git pull failed, using cached templates.",
        );
      }
    }
    return DEFAULT_AGENTS_PATH;
  }

  console.error(`[agency] Downloading agent templates from ${REPO_URL}`);
  mkdirSync(CACHE_DIR, { recursive: true });
  try {
    execSync(`git clone --depth 1 ${REPO_URL} ${DEFAULT_AGENTS_PATH}`, {
      stdio: "ignore",
      timeout: 30_000,
    });
    markPulled();
  } catch {
    console.error(
      "[agency] Fatal: Could not clone agent templates. Ensure git is installed.",
    );
    process.exit(1);
  }
  return DEFAULT_AGENTS_PATH;
}

const agentsPath = ensureAgentsPath();

console.error(`[agency] Scanning agents in: ${agentsPath}`);
const state = createIndexState(agentsPath);

if (state.records.length === 0) {
  console.error("[agency] Fatal: No agents found.");
  process.exit(1);
}

console.error(
  `[agency] Indexed ${state.records.length} agents across ${state.divisions.length} divisions.`,
);

const server = new McpServer({
  name: "agency",
  version: pkg.version,
});

registerHandlers(server, state, {
  agentsPath,
  isLocalPath: !!process.env.AGENCY_AGENTS_PATH,
  updateIntervalMs: UPDATE_INTERVAL_MS,
  lastPullTimestamp,
  shouldPull,
  pullRepo,
});

const PORT = process.env.PORT ? Number(process.env.PORT) : null;

async function main() {
  if (PORT !== null) {
    const transports = new Map<string, SSEServerTransport>();

    const httpServer = createServer(async (req, res) => {
      const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

      // Full CORS headers on every request
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader(
        "Access-Control-Allow-Headers",
        "Content-Type, Authorization, mcp-session-id",
      );
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

      // CORS preflight
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            status: "ok",
            agents: state.records.length,
            version: pkg.version,
          }),
        );
        return;
      }

      if (req.method === "GET" && url.pathname === "/sse") {
        const transport = new SSEServerTransport("/messages", res);
        transports.set(transport.sessionId, transport);
        res.on("close", () => transports.delete(transport.sessionId));
        await server.connect(transport);
        return;
      }

      if (req.method === "POST" && url.pathname === "/messages") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "Missing sessionId" }));
          return;
        }
        const transport = transports.get(sessionId);
        if (!transport) {
          res.writeHead(404);
          res.end(JSON.stringify({ error: "Session not found" }));
          return;
        }
        await transport.handlePostMessage(req, res);
        return;
      }

      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    });

    httpServer.listen(PORT, () =>
      console.error(
        `[agency] MCP server v${pkg.version} running on HTTP/SSE at http://0.0.0.0:${PORT}/sse`,
      ),
    );
  } else {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(`[agency] MCP server v${pkg.version} running on stdio.`);
  }
}

main().catch((error) => {
  console.error("[agency] Fatal error:", error);
  process.exit(1);
});
