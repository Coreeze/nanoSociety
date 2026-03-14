/**
 * server.ts — HTTP + WebSocket server for the nanoSociety web UI.
 * Serves static files from public/ and broadcasts simulation state
 * to all connected clients each tick via WebSocket.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import type { Participant, Team, PhaseName } from './types.js';
import type { LogEntry } from './renderer.js';

export interface TickPayload {
  tick: number;
  totalTicks: number;
  time: string;
  phase: PhaseName;
  participants: Participant[];
  teams: Team[];
  recentLogs: LogEntry[];
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

let wss: WebSocketServer;
let startResolve: (() => void) | null = null;

export function startServer(port: number): void {
  const publicDir = path.resolve('public');

  const server = http.createServer((req, res) => {
    const url = req.url === '/' ? '/index.html' : req.url!;
    const filePath = path.join(publicDir, url);

    if (!filePath.startsWith(publicDir)) {
      res.writeHead(403);
      res.end();
      return;
    }

    const ext = path.extname(filePath);
    const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end('Not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(data);
    });
  });

  wss = new WebSocketServer({ server });

  wss.on('connection', (socket) => {
    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.cmd === 'start' && startResolve) {
          startResolve();
          startResolve = null;
        }
      } catch {
        // ignore malformed messages
      }
    });
  });

  server.listen(port, () => {
    console.log(`  nanoSociety UI → http://localhost:${port}`);
  });
}

export function waitForStart(): Promise<void> {
  return new Promise((resolve) => {
    startResolve = resolve;
  });
}

export function broadcast(payload: TickPayload): void {
  if (!wss) return;
  const data = JSON.stringify({ type: 'tick', ...payload });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

export function broadcastProgress(message: string): void {
  if (!wss) return;
  const data = JSON.stringify({ type: 'progress', message });
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}
