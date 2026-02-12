import {
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
} from "fs";
import { join } from "path";

export interface SessionIndexEntry {
  sessionId: string;
  createdAt: number;
  lastUpdatedAt: number;
  workspace?: string;
  firstPrompt?: string;
}

export interface SessionMeta {
  sessionId: string;
  createdAt: number;
  lastUpdatedAt: number;
  workspace?: string;
  model?: string;
  source?: string;
  totalCostUsd?: number;
  totalDurationMs?: number;
  totalTurns?: number;
  firstPrompt?: string;
  streamEventCount: number;
  hookEventCount: number;
}

interface PersistedEvent {
  seq: number;
  ts: number;
  type?: string;
  data: Record<string, unknown>;
}

/**
 * Persists Claude Code session data independently:
 * - Session index (index.json) for quick lookups
 * - Per-session meta.json, stream.jsonl, hooks.jsonl
 */
export class EventStore {
  private storeDir: string;
  private sessionsDir: string;
  private indexPath: string;
  private index = new Map<string, SessionIndexEntry>();
  private streamSeqs = new Map<string, number>();
  private hookSeqs = new Map<string, number>();
  private indexDirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(dataDir: string) {
    this.storeDir = join(dataDir, "store");
    this.sessionsDir = join(this.storeDir, "sessions");
    this.indexPath = join(this.storeDir, "index.json");
    this.loadIndex();
  }

  /** Ensure a session directory and meta.json exist. Idempotent. */
  ensureSession(sessionId: string, meta?: Partial<SessionMeta>): void {
    const dir = this.sessionDir(sessionId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    const metaPath = join(dir, "meta.json");
    const now = Date.now();

    if (!existsSync(metaPath)) {
      const initial: SessionMeta = {
        sessionId,
        createdAt: now,
        lastUpdatedAt: now,
        streamEventCount: 0,
        hookEventCount: 0,
        ...meta,
      };
      writeFileSync(metaPath, JSON.stringify(initial, null, 2));

      this.index.set(sessionId, {
        sessionId,
        createdAt: now,
        lastUpdatedAt: now,
        workspace: meta?.workspace,
        firstPrompt: meta?.firstPrompt,
      });
      this.markIndexDirty();
    } else if (meta) {
      this.updateSessionMeta(sessionId, meta);
    }
  }

  /** Append a raw stream JSON event for a session. */
  appendStreamEvent(
    sessionId: string,
    rawEvent: Record<string, unknown>
  ): void {
    this.ensureSession(sessionId);

    const seq = (this.streamSeqs.get(sessionId) ?? 0) + 1;
    this.streamSeqs.set(sessionId, seq);

    const entry: PersistedEvent = {
      seq,
      ts: Date.now(),
      type: rawEvent.type as string | undefined,
      data: rawEvent,
    };

    const filePath = join(this.sessionDir(sessionId), "stream.jsonl");
    appendFileSync(filePath, JSON.stringify(entry) + "\n");

    this.incrementMetaCount(sessionId, "streamEventCount");
    this.touchSession(sessionId);
  }

  /** Append a hook event for a session. */
  appendHookEvent(
    sessionId: string,
    hookType: string,
    data: Record<string, unknown>
  ): void {
    this.ensureSession(sessionId);

    const seq = (this.hookSeqs.get(sessionId) ?? 0) + 1;
    this.hookSeqs.set(sessionId, seq);

    const entry: PersistedEvent = {
      seq,
      ts: Date.now(),
      type: hookType,
      data,
    };

    const filePath = join(this.sessionDir(sessionId), "hooks.jsonl");
    appendFileSync(filePath, JSON.stringify(entry) + "\n");

    this.incrementMetaCount(sessionId, "hookEventCount");
    this.touchSession(sessionId);
  }

  /** Update session metadata fields (merges into existing meta.json). */
  updateSessionMeta(sessionId: string, updates: Partial<SessionMeta>): void {
    const metaPath = join(this.sessionDir(sessionId), "meta.json");
    if (!existsSync(metaPath)) return;

    try {
      const existing: SessionMeta = JSON.parse(
        readFileSync(metaPath, "utf-8")
      );
      const merged = { ...existing, ...updates, lastUpdatedAt: Date.now() };
      writeFileSync(metaPath, JSON.stringify(merged, null, 2));

      // Sync index entry
      const indexEntry = this.index.get(sessionId);
      if (indexEntry) {
        indexEntry.lastUpdatedAt = merged.lastUpdatedAt;
        if (updates.workspace) indexEntry.workspace = updates.workspace;
        if (updates.firstPrompt && !indexEntry.firstPrompt) indexEntry.firstPrompt = updates.firstPrompt;
        this.markIndexDirty();
      }
    } catch {
      // Corrupted meta, skip
    }
  }

  /** Get the most recent session ID by lastUpdatedAt. */
  getMostRecentSessionId(): string | undefined {
    let best: SessionIndexEntry | undefined;
    for (const entry of this.index.values()) {
      if (!best || entry.lastUpdatedAt > best.lastUpdatedAt) {
        best = entry;
      }
    }
    return best?.sessionId;
  }

  /** Get metadata for a session. */
  getSessionMeta(sessionId: string): SessionMeta | undefined {
    const metaPath = join(this.sessionDir(sessionId), "meta.json");
    if (!existsSync(metaPath)) return undefined;
    try {
      return JSON.parse(readFileSync(metaPath, "utf-8"));
    } catch {
      return undefined;
    }
  }

  /** List all sessions sorted by lastUpdatedAt descending. */
  listSessions(): SessionIndexEntry[] {
    return Array.from(this.index.values()).sort(
      (a, b) => b.lastUpdatedAt - a.lastUpdatedAt
    );
  }

  /** Read stream events for a session. */
  readStreamEvents(sessionId: string): PersistedEvent[] {
    return this.readJsonl(join(this.sessionDir(sessionId), "stream.jsonl"));
  }

  /** Read hook events for a session. */
  readHookEvents(sessionId: string): PersistedEvent[] {
    return this.readJsonl(join(this.sessionDir(sessionId), "hooks.jsonl"));
  }

  /** Flush pending index writes. Call on shutdown. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.indexDirty) {
      this.saveIndex();
      this.indexDirty = false;
    }
  }

  // --- Private ---

  private sessionDir(sessionId: string): string {
    return join(this.sessionsDir, sessionId);
  }

  private touchSession(sessionId: string): void {
    const entry = this.index.get(sessionId);
    if (entry) {
      entry.lastUpdatedAt = Date.now();
      this.markIndexDirty();
    }
  }

  private incrementMetaCount(
    sessionId: string,
    field: "streamEventCount" | "hookEventCount"
  ): void {
    const metaPath = join(this.sessionDir(sessionId), "meta.json");
    if (!existsSync(metaPath)) return;
    try {
      const meta: SessionMeta = JSON.parse(readFileSync(metaPath, "utf-8"));
      meta[field] = (meta[field] ?? 0) + 1;
      meta.lastUpdatedAt = Date.now();
      writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    } catch {
      // skip
    }
  }

  private markIndexDirty(): void {
    this.indexDirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        if (this.indexDirty) {
          this.saveIndex();
          this.indexDirty = false;
        }
      }, 2000);
    }
  }

  private loadIndex(): void {
    if (!existsSync(this.indexPath)) {
      this.rebuildIndex();
      return;
    }
    try {
      const data: SessionIndexEntry[] = JSON.parse(
        readFileSync(this.indexPath, "utf-8")
      );
      for (const entry of data) {
        this.index.set(entry.sessionId, entry);
      }
    } catch {
      this.rebuildIndex();
    }
  }

  private saveIndex(): void {
    if (!existsSync(this.storeDir)) {
      mkdirSync(this.storeDir, { recursive: true });
    }
    const entries = Array.from(this.index.values());
    writeFileSync(this.indexPath, JSON.stringify(entries, null, 2));
  }

  private rebuildIndex(): void {
    this.index.clear();
    if (!existsSync(this.sessionsDir)) return;

    try {
      const dirs = readdirSync(this.sessionsDir, { withFileTypes: true });
      for (const dir of dirs) {
        if (!dir.isDirectory()) continue;
        const metaPath = join(this.sessionsDir, dir.name, "meta.json");
        if (!existsSync(metaPath)) continue;
        try {
          const meta: SessionMeta = JSON.parse(
            readFileSync(metaPath, "utf-8")
          );
          this.index.set(meta.sessionId, {
            sessionId: meta.sessionId,
            createdAt: meta.createdAt,
            lastUpdatedAt: meta.lastUpdatedAt,
            workspace: meta.workspace,
            firstPrompt: meta.firstPrompt,
          });
        } catch {
          // Skip corrupted meta
        }
      }
    } catch {
      // sessionsDir read failed
    }

    if (this.index.size > 0) {
      this.saveIndex();
    }
  }

  private readJsonl(filePath: string): PersistedEvent[] {
    if (!existsSync(filePath)) return [];
    try {
      const content = readFileSync(filePath, "utf-8");
      return content
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line));
    } catch {
      return [];
    }
  }
}
