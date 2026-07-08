#!/usr/bin/env node
// @termenal-web/terminal-server
//
// The host side of the real browser terminal. It spawns a genuine OS shell
// through a pseudo-terminal (ConPTY on Windows via node-pty) and bridges its
// bytes to the browser over a WebSocket. The browser keeps the VT state and
// renders it with our Arabic-correct pipeline; this process owns the real PTY.
//
// Protocol (JSON text frames):
//   server -> client: { type: 'ready', shell, pid, cols, rows }
//                     { type: 'data',  data }              // raw PTY output
//                     { type: 'exit',  code }
//   client -> server: { type: 'input',  data }            // keystrokes / paste
//                     { type: 'resize', cols, rows }
//
// This binds to loopback only and rejects non-local WebSocket origins, so it is
// a local developer tool — not a remotely reachable shell.

import os from 'node:os';
import { WebSocketServer } from 'ws';
import * as pty from '@homebridge/node-pty-prebuilt-multiarch';

const HOST = process.env.TERMENAL_HOST ?? '127.0.0.1';
const PORT = Number(process.env.TERMENAL_PORT ?? 5179);
const isWindows = os.platform() === 'win32';

/** The shell to spawn. Override with TERMENAL_SHELL (e.g. pwsh, cmd.exe, bash). */
const SHELL =
  process.env.TERMENAL_SHELL ??
  (isWindows ? 'powershell.exe' : process.env.SHELL ?? 'bash');

/** Default args: PowerShell without the banner; nothing special elsewhere. */
const SHELL_ARGS = process.env.TERMENAL_SHELL_ARGS
  ? process.env.TERMENAL_SHELL_ARGS.split(' ').filter(Boolean)
  : /powershell|pwsh/i.test(SHELL)
    ? ['-NoLogo']
    : [];

/** Accept only browser origins served from loopback (or non-browser clients). */
function isLocalOrigin(origin) {
  if (!origin) return true; // curl / wscat / non-browser: no Origin header
  try {
    const { hostname } = new URL(origin);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]';
  } catch {
    return false;
  }
}

const wss = new WebSocketServer({
  host: HOST,
  port: PORT,
  verifyClient: ({ origin }) => isLocalOrigin(origin),
});

wss.on('listening', () => {
  console.log(`[termenal] PTY bridge listening on ws://${HOST}:${PORT}`);
  console.log(`[termenal] shell: ${SHELL} ${SHELL_ARGS.join(' ')}`);
  console.log('[termenal] open the browser terminal and it will connect here.');
});

wss.on('error', (err) => {
  console.error('[termenal] server error:', err.message);
  process.exit(1);
});

wss.on('connection', (ws, req) => {
  const cwd = process.env.TERMENAL_CWD ?? os.homedir() ?? process.cwd();
  let child;
  try {
    child = pty.spawn(SHELL, SHELL_ARGS, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: process.env,
    });
  } catch (err) {
    console.error('[termenal] failed to spawn shell:', err.message);
    safeSend(ws, { type: 'exit', code: -1, error: String(err.message) });
    ws.close();
    return;
  }

  const peer = req.socket.remoteAddress;
  console.log(`[termenal] client ${peer} -> shell pid ${child.pid}`);
  safeSend(ws, { type: 'ready', shell: SHELL, pid: child.pid, cols: 80, rows: 24 });

  const onData = child.onData((data) => safeSend(ws, { type: 'data', data }));
  const onExit = child.onExit(({ exitCode }) => {
    safeSend(ws, { type: 'exit', code: exitCode });
    try {
      ws.close();
    } catch {
      /* already closing */
    }
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }
    if (msg.type === 'input' && typeof msg.data === 'string') {
      child.write(msg.data);
    } else if (
      msg.type === 'resize' &&
      Number.isInteger(msg.cols) &&
      Number.isInteger(msg.rows) &&
      msg.cols > 0 &&
      msg.rows > 0
    ) {
      try {
        child.resize(msg.cols, msg.rows);
      } catch {
        /* race with exit: ignore */
      }
    }
  });

  const cleanup = () => {
    onData.dispose();
    onExit.dispose();
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    console.log(`[termenal] client ${peer} disconnected; shell pid ${child.pid} killed`);
  };
  ws.on('close', cleanup);
  ws.on('error', cleanup);
});

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}
