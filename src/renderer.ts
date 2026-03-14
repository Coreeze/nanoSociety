/**
 * renderer.ts — Shared types for the simulation log entries.
 * The actual rendering is now handled by the web client (public/index.html).
 */

export interface LogEntry {
  name: string;
  action: string;
  actionType: string;
  teamId?: string | null;
}
