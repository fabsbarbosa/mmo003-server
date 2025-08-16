// server/index.js (CommonJS para evitar problemas de ES modules)
const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');
const { performance } = require('perf_hooks');

const PORT = process.env.PORT || 8080;
const server = http.createServer();
const wss = new WebSocket.Server({ server });

const TICK_HZ = 30;               // simulação
const SNAPSHOT_HZ = 10;           // rede
const SPEED = 3.5;                // unidades/s
const MAX_BUFFERED = 512 * 1024;  // 512KB
const MAX_INPUTS_PER_SEC = 30;
const WORLD = { width: 50, height: 30 }; // "unidades de mundo" (não pixels)

const players = new Map(); // id -> {x,y,vx,vy,seq,lastInputTs,ws,lastAckSeq}
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

wss.on('connection', (ws) => {
  const id = randomUUID();
  const now = Date.now();
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  players.set(id, {
    id, x: Math.random() * WORLD.width, y: Math.random() * WORLD.height,
    vx: 0, vy: 0, seq: 0, lastInputTs: now, ws, lastAckSeq: 0,
  });

  ws.send(JSON.stringify({ t: 'welcome', id, world: WORLD }));

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    const p = players.get(id);
    if (!p) return;

    if (msg.t === 'input') {
      const ts = Date.now();
      const dt = Math.max(1, ts - p.lastInputTs);
      const ips = 1000 / dt;
      if (ips > MAX_INPUTS_PER_SEC) return; // rate limit simples
      p.lastInputTs = ts;

      const dx = (msg.r - msg.l);
      const dy = (msg.d - msg.u);
      const len = Math.hypot(dx, dy) || 1;
      p.vx = (dx / len) * SPEED;
      p.vy = (dy / len) * SPEED;
      p.seq = Math.max(p.seq, msg.seq | 0);
    }
  });

  ws.on('close', () => { players.delete(id); });
  ws.on('error', () => {});
});

// Tick fixo da simulação
let last = performance.now();
const TICK_MS = 1000 / TICK_HZ;
let acc = 0;

setInterval(() => {
  const now = performance.now();
  acc += now - last;
  last = now;
  while (acc >= TICK_MS) {
    simulate(TICK_MS / 1000);
    acc -= TICK_MS;
  }
}, 4);

function simulate(dt) {
  for (const p of players.values()) {
    p.x = clamp(p.x + p.vx * dt, 0, WORLD.width);
    p.y = clamp(p.y + p.vy * dt, 0, WORLD.height);
    p.lastAckSeq = p.seq;
  }
}

// Snapshots desacoplados (reduz banda)
setInterval(() => {
  const snapshot = {
    t: 'snapshot',
    ts: Date.now(),
    players: Array.from(players.values()).map(p => ({
      id: p.id, x: +p.x.toFixed(3), y: +p.y.toFixed(3), ack: p.lastAckSeq
    }))
  };
  const payload = JSON.stringify(snapshot);
  for (const p of players.values()) {
    const ws = p.ws;
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (ws.bufferedAmount > MAX_BUFFERED) continue; // backpressure
    ws.send(payload);
  }
}, 1000 / SNAPSHOT_HZ);

// Heartbeat: remove conexões mortas (evita "ghost players")
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  });
}, 15000);

server.listen(PORT, () => console.log('Server on :' + PORT));