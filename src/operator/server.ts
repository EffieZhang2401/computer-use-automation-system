/**
 * Minimal operator console — SSE push of InterventionRequest + control buttons.
 * Degraded mode: no CDP screencast; operator completes the step in the open browser.
 */
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import {
  getSession,
  listSessions,
  onSessionEvent,
  type SessionEvent,
  type SessionSnapshot,
} from "../session/manager.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_PORT = 3200;

export type OperatorServer = {
  port: number;
  url: string;
  close: () => Promise<void>;
};

let singleton: OperatorServer | null = null;

type SseClient = {
  id: number;
  write: (chunk: string) => void;
};

export async function startOperatorServer(opts?: {
  port?: number;
}): Promise<OperatorServer> {
  if (singleton !== null) {
    return singleton;
  }

  const port = opts?.port ?? Number(process.env.OPERATOR_PORT ?? DEFAULT_PORT);
  const app = express();
  app.use(express.json());

  const sseClients = new Set<SseClient>();
  let nextClientId = 1;

  const broadcast = (event: string, data: unknown): void => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of sseClients) {
      try {
        client.write(payload);
      } catch {
        sseClients.delete(client);
      }
    }
  };

  const unsubscribe = onSessionEvent((event: SessionEvent) => {
    broadcast(event.type, event);
  });

  app.get("/", async (_req, res) => {
    const htmlPath = path.join(__dirname, "console.html");
    const html = await readFile(htmlPath, "utf8");
    res.type("html").send(html);
  });

  app.get("/api/sessions", (_req, res) => {
    res.json({
      sessions: listSessions().map((s) => s.snapshot()),
    });
  });

  app.get("/api/events", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders?.();

    const client: SseClient = {
      id: nextClientId++,
      write: (chunk) => {
        res.write(chunk);
      },
    };
    sseClients.add(client);

    const snapshot = {
      sessions: listSessions().map((s) => s.snapshot()),
    };
    res.write(`event: hello\ndata: ${JSON.stringify(snapshot)}\n\n`);

    req.on("close", () => {
      sseClients.delete(client);
    });
  });

  app.post("/api/sessions/:sessionId/take-control", (req, res) => {
    const session = getSession(req.params.sessionId);
    if (session === undefined) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    try {
      session.takeControl();
      res.json({ ok: true, session: session.snapshot() });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/sessions/:sessionId/hand-back", (req, res) => {
    const session = getSession(req.params.sessionId);
    if (session === undefined) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    try {
      const note =
        typeof req.body?.note === "string" && req.body.note.trim() !== ""
          ? req.body.note.trim()
          : undefined;
      session.handBack(note);
      res.json({ ok: true, session: session.snapshot() });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/sessions/:sessionId/abort", (req, res) => {
    const session = getSession(req.params.sessionId);
    if (session === undefined) {
      res.status(404).json({ error: "session not found" });
      return;
    }
    try {
      const reason =
        typeof req.body?.reason === "string" ? req.body.reason : undefined;
      session.abort(reason);
      res.json({ ok: true, session: session.snapshot() });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const server: Server = createServer(app);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const url = `http://127.0.0.1:${port}`;
  console.log(`Operator console listening on ${url}`);

  singleton = {
    port,
    url,
    close: async () => {
      unsubscribe();
      for (const client of sseClients) {
        sseClients.delete(client);
      }
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      singleton = null;
    },
  };

  return singleton;
}

export async function ensureOperatorServer(opts?: {
  port?: number;
}): Promise<OperatorServer> {
  return startOperatorServer(opts);
}

/** Test helper — expose session list shape for console bootstrap. */
export function sessionsSnapshot(): SessionSnapshot[] {
  return listSessions().map((s) => s.snapshot());
}
