import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import type { PendingQuestion } from "./claude-bridge";

/** Per-workspace session data. */
export interface WorkspaceSession {
  claudeSessionId: string;
  workspace: string;
  lastActive: number;
  messageCount: number;
  /** When set, the session has a pending plan awaiting user confirmation. */
  pendingPlan?: boolean;
  /** When set, Claude asked a question and is waiting for a user reply. */
  pendingQuestion?: PendingQuestion;
}

/** Per-sender state containing an active workspace and all workspace sessions. */
interface SenderState {
  activeWorkspace: string;
  /** Normalized absolute path → WorkspaceSession */
  workspaceSessions: Record<string, WorkspaceSession>;
}

/** Old single-session format for migration detection. */
interface LegacySessionEntry {
  claudeSessionId: string;
  workspace: string;
  lastActive: number;
  messageCount: number;
  pendingPlan?: boolean;
  pendingQuestion?: PendingQuestion;
}

/**
 * Manages the mapping between OpenClaw sender IDs and Claude Code sessions.
 * Supports multiple independent workspace sessions per sender.
 * Persists sessions to disk so they survive plugin restarts.
 */
export class SessionManager {
  private senderStates = new Map<string, SenderState>();
  private persistPath: string;

  constructor(dataDir: string) {
    this.persistPath = join(dataDir, "sessions.json");
    this.load();
  }

  // ── Active workspace ────────────────────────────────────────────────

  /** Get the active workspace for a sender. */
  getActiveWorkspace(senderId: string): string | undefined {
    return this.senderStates.get(senderId)?.activeWorkspace;
  }

  /** Set the active workspace for a sender (does not affect any session). */
  setActiveWorkspace(senderId: string, workspace: string): void {
    const state = this.ensureSenderState(senderId, workspace);
    state.activeWorkspace = workspace;
    this.save();
  }

  // ── Workspace session CRUD ──────────────────────────────────────────

  /** Get session for a specific workspace. */
  getSession(senderId: string, workspace: string): WorkspaceSession | undefined {
    return this.senderStates.get(senderId)?.workspaceSessions[workspace];
  }

  /** Update or create a workspace session after a Claude invocation. */
  updateSession(senderId: string, workspace: string, claudeSessionId: string): void {
    const state = this.ensureSenderState(senderId, workspace);
    const existing = state.workspaceSessions[workspace];
    state.workspaceSessions[workspace] = {
      claudeSessionId,
      workspace,
      lastActive: Date.now(),
      messageCount: (existing?.messageCount ?? 0) + 1,
    };
    this.save();
  }

  /** Remove a specific workspace session. Returns true if it existed. */
  removeSession(senderId: string, workspace: string): boolean {
    const state = this.senderStates.get(senderId);
    if (!state || !(workspace in state.workspaceSessions)) return false;

    delete state.workspaceSessions[workspace];

    // If removed workspace was active, switch to the most recent remaining
    if (state.activeWorkspace === workspace) {
      const remaining = Object.values(state.workspaceSessions);
      if (remaining.length > 0) {
        remaining.sort((a, b) => b.lastActive - a.lastActive);
        state.activeWorkspace = remaining[0].workspace;
      }
    }

    // Clean up sender state if no sessions remain
    if (Object.keys(state.workspaceSessions).length === 0) {
      this.senderStates.delete(senderId);
    }

    this.save();
    return true;
  }

  /** Remove all workspace sessions for a sender. Returns count removed. */
  removeAllSessions(senderId: string): number {
    const state = this.senderStates.get(senderId);
    if (!state) return 0;
    const count = Object.keys(state.workspaceSessions).length;
    this.senderStates.delete(senderId);
    this.save();
    return count;
  }

  /** List all workspace sessions for a sender, sorted by lastActive descending. */
  listSessions(senderId: string): WorkspaceSession[] {
    const state = this.senderStates.get(senderId);
    if (!state) return [];
    return Object.values(state.workspaceSessions).sort(
      (a, b) => b.lastActive - a.lastActive
    );
  }

  // ── Pending plan / question (workspace-scoped) ──────────────────────

  setPendingPlan(senderId: string, workspace: string, pending: boolean): void {
    const session = this.getSession(senderId, workspace);
    if (session) {
      session.pendingPlan = pending || undefined;
      session.lastActive = Date.now();
      this.save();
    }
  }

  hasPendingPlan(senderId: string, workspace: string): boolean {
    return this.getSession(senderId, workspace)?.pendingPlan === true;
  }

  setPendingQuestion(senderId: string, workspace: string, question: PendingQuestion | undefined): void {
    const session = this.getSession(senderId, workspace);
    if (session) {
      session.pendingQuestion = question;
      session.lastActive = Date.now();
      this.save();
    }
  }

  getPendingQuestion(senderId: string, workspace: string): PendingQuestion | undefined {
    return this.getSession(senderId, workspace)?.pendingQuestion;
  }

  // ── Backward-compatible convenience methods ─────────────────────────

  /** Get Claude session ID for the active workspace. */
  get(senderId: string): string | undefined {
    const ws = this.getActiveWorkspace(senderId);
    if (!ws) return undefined;
    return this.getSession(senderId, ws)?.claudeSessionId;
  }

  /** Get session entry for the active workspace. */
  getEntry(senderId: string): WorkspaceSession | undefined {
    const ws = this.getActiveWorkspace(senderId);
    if (!ws) return undefined;
    return this.getSession(senderId, ws);
  }

  /** Get the active workspace (alias for getActiveWorkspace). */
  getWorkspace(senderId: string): string | undefined {
    return this.getActiveWorkspace(senderId);
  }

  /** List all active sessions across all senders. */
  list(): Array<{ senderId: string } & WorkspaceSession> {
    const result: Array<{ senderId: string } & WorkspaceSession> = [];
    for (const [senderId, state] of this.senderStates.entries()) {
      for (const session of Object.values(state.workspaceSessions)) {
        result.push({ senderId, ...session });
      }
    }
    return result;
  }

  // ── Internal helpers ────────────────────────────────────────────────

  private ensureSenderState(senderId: string, defaultWorkspace: string): SenderState {
    let state = this.senderStates.get(senderId);
    if (!state) {
      state = { activeWorkspace: defaultWorkspace, workspaceSessions: {} };
      this.senderStates.set(senderId, state);
    }
    return state;
  }

  private isLegacyFormat(value: unknown): value is LegacySessionEntry {
    return (
      typeof value === "object" &&
      value !== null &&
      "claudeSessionId" in value &&
      "workspace" in value &&
      !("activeWorkspace" in value)
    );
  }

  private load(): void {
    if (!existsSync(this.persistPath)) return;
    try {
      const data = JSON.parse(readFileSync(this.persistPath, "utf-8"));
      for (const [senderId, value] of Object.entries(data)) {
        if (this.isLegacyFormat(value)) {
          // Migrate old single-session format
          const legacy = value;
          this.senderStates.set(senderId, {
            activeWorkspace: legacy.workspace,
            workspaceSessions: {
              [legacy.workspace]: {
                claudeSessionId: legacy.claudeSessionId,
                workspace: legacy.workspace,
                lastActive: legacy.lastActive,
                messageCount: legacy.messageCount,
                pendingPlan: legacy.pendingPlan,
                pendingQuestion: legacy.pendingQuestion,
              },
            },
          });
        } else {
          // New format
          const state = value as SenderState;
          this.senderStates.set(senderId, {
            activeWorkspace: state.activeWorkspace,
            workspaceSessions: state.workspaceSessions ?? {},
          });
        }
      }
    } catch {
      // Corrupted file, start fresh
    }
  }

  private save(): void {
    const dir = dirname(this.persistPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    const data: Record<string, SenderState> = {};
    for (const [senderId, state] of this.senderStates.entries()) {
      data[senderId] = state;
    }
    writeFileSync(this.persistPath, JSON.stringify(data, null, 2));
  }
}
