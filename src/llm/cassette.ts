/**
 * Disk-backed LLM response cache keyed by a normalized prompt hash.
 *
 * Volatile fields (runId, timestamps, …) are stripped before hashing so
 * identical page states hit the cache across dev iterations.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LLMRequest, LLMResponse } from "./types.js";

export class CassetteMissError extends Error {
  readonly kind = "cassette_miss" as const;

  constructor(readonly cacheKey: string) {
    super(`Cassette miss for key ${cacheKey}`);
    this.name = "CassetteMissError";
  }
}

/** Keys removed recursively before computing the cache hash. */
export const VOLATILE_CACHE_KEYS = new Set([
  "runId",
  "run_id",
  "timestamp",
  "recordedAt",
  "createdAt",
  "updatedAt",
  "discoveryRunId",
  "evidenceDir",
  "durationMs",
]);

export type CassetteEntry = {
  cacheKey: string;
  model: string;
  promptVersion: string;
  request: LLMRequest;
  response: LLMResponse;
  recordedAt: string;
};

const DEFAULT_CASSETTE_DIR = path.resolve(".cassettes");

/**
 * Deep-clone `value`, dropping volatile keys so two requests that differ
 * only by run metadata produce the same hash.
 */
export function normalizeForCacheKey(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(normalizeForCacheKey);
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (VOLATILE_CACHE_KEYS.has(key)) continue;
      out[key] = normalizeForCacheKey(child);
    }
    return out;
  }
  return value;
}

/** Stable SHA-256 hex digest for a discovery LLM request. */
export function hashRequest(request: LLMRequest): string {
  const normalized = normalizeForCacheKey(request);
  const payload = JSON.stringify(normalized);
  return createHash("sha256").update(payload).digest("hex");
}

export class CassetteStore {
  constructor(private readonly dir: string = DEFAULT_CASSETTE_DIR) {}

  async read(request: LLMRequest): Promise<LLMResponse | null> {
    const cacheKey = hashRequest(request);
    const filePath = this.pathForKey(cacheKey);
    try {
      const raw = await readFile(filePath, "utf8");
      const entry = JSON.parse(raw) as CassetteEntry;
      if (entry.cacheKey !== cacheKey) {
        throw new Error(`Cassette key mismatch in ${filePath}`);
      }
      return entry.response;
    } catch (err) {
      if (isENOENT(err)) return null;
      throw err;
    }
  }

  /** Replay mode: read or throw — never falls through to the network. */
  async readOrThrow(request: LLMRequest): Promise<LLMResponse> {
    const response = await this.read(request);
    if (response === null) {
      throw new CassetteMissError(hashRequest(request));
    }
    return response;
  }

  async write(request: LLMRequest, response: LLMResponse): Promise<string> {
    const cacheKey = hashRequest(request);
    await mkdir(this.dir, { recursive: true });
    const entry: CassetteEntry = {
      cacheKey,
      model: request.model,
      promptVersion: request.promptVersion,
      request,
      response,
      recordedAt: new Date().toISOString(),
    };
    const filePath = this.pathForKey(cacheKey);
    await writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, "utf8");
    return filePath;
  }

  pathForKey(cacheKey: string): string {
    return path.join(this.dir, `${cacheKey}.json`);
  }
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
