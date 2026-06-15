// ═══════════════════════════════════════════════════════
//  BRAWL ARENA — Multiplayer Server (up to 5 players/room)
// ═══════════════════════════════════════════════════════
// Deploy this on Render.com (free tier):
//   1. Create new "Web Service"
//   2. Upload server.js + package.json
//   3. Build command: npm install
//   4. Start command: node server.js
//   5. Copy the URL Render gives you (e.g. https://yourgame.onrender.com)
//   6. In the game HTML, set SERVER_URL to that URL but with "wss://" instead of "https://"
// ═══════════════════════════════════════════════════════

const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS = 5;
const TICK_RATE = 1000 / 30; // 30 updates/sec broadcast

// Simple HTTP server (so Render sees a live port + health checks pass)
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Brawl Arena server is running.\n');
});

const wss = new WebSocket.Server({ server });

// rooms: { code: { players: Map(id -> {ws, state}), hostId, started } }
const rooms = new Map();

function genRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function broadcast(room, msg, exceptId) {
  const data = JSON.stringify(msg);
  for (const [id, p] of room.players) {
    if (id === exceptId) continue;
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send(data);
  }
}

function roomSummary(room) {
  return Array.from(room.players.values()).map(p => ({
    id: p.id, name: p.name, charId: p.charId, ready: p.ready, isHost: p.id === room.hostId,
  }));
}

wss.on('connection', (ws) => {
  let playerId = null;
  let roomCode = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'create_room': {
        roomCode = genRoomCode();
        playerId = 'p_' + Math.random().toString(36).slice(2, 9);
        const room = {
          players: new Map(),
          hostId: playerId,
          started: false,
          stageKey: 'meadow',
        };
        rooms.set(roomCode, room);
        room.players.set(playerId, { id: playerId, ws, name: msg.name || 'Player', charId: msg.charId || 'knight', ready: false });
        ws.send(JSON.stringify({ type: 'room_created', roomCode, playerId, players: roomSummary(room) }));
        break;
      }

      case 'join_room': {
        const room = rooms.get(msg.roomCode);
        if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Room not found.' })); return; }
        if (room.players.size >= MAX_PLAYERS) { ws.send(JSON.stringify({ type: 'error', message: 'Room is full (max 5).' })); return; }
        if (room.started) { ws.send(JSON.stringify({ type: 'error', message: 'Match already in progress.' })); return; }

        roomCode = msg.roomCode;
        playerId = 'p_' + Math.random().toString(36).slice(2, 9);
        room.players.set(playerId, { id: playerId, ws, name: msg.name || 'Player', charId: msg.charId || 'knight', ready: false });

        ws.send(JSON.stringify({ type: 'room_joined', roomCode, playerId, players: roomSummary(room) }));
        broadcast(room, { type: 'player_list', players: roomSummary(room) }, playerId);
        break;
      }

      case 'set_char': {
        const room = rooms.get(roomCode);
        if (!room) return;
        const p = room.players.get(playerId);
        if (!p) return;
        p.charId = msg.charId;
        broadcast(room, { type: 'player_list', players: roomSummary(room) });
        break;
      }

      case 'toggle_ready': {
        const room = rooms.get(roomCode);
        if (!room) return;
        const p = room.players.get(playerId);
        if (!p) return;
        p.ready = !p.ready;
        broadcast(room, { type: 'player_list', players: roomSummary(room) });

        // Auto-start if everyone ready and >= 2 players
        const all = Array.from(room.players.values());
        if (all.length >= 2 && all.every(pl => pl.ready) && !room.started) {
          room.started = true;
          // Only free stages are used online, since paid stage unlocks (fire/space)
          // are tracked per-player and not all participants may own them.
          const stages = ['meadow', 'ice', 'sky', 'garden'];
          room.stageKey = stages[Math.floor(Math.random() * stages.length)];
          const startMsg = {
            type: 'match_start',
            players: all.map((pl, i) => ({ id: pl.id, name: pl.name, charId: pl.charId, slot: i })),
            stageKey: room.stageKey,
          };
          broadcast(room, startMsg);
          ws.send(JSON.stringify(startMsg));
        }
        break;
      }

      case 'state': {
        // Player sends their own fighter state; relay to everyone else
        const room = rooms.get(roomCode);
        if (!room || !room.started) return;
        broadcast(room, { type: 'state', id: playerId, state: msg.state }, playerId);
        break;
      }

      case 'hit': {
        // Player reports they hit someone; relay so victim applies damage locally
        const room = rooms.get(roomCode);
        if (!room || !room.started) return;
        broadcast(room, { type: 'hit', from: playerId, targetId: msg.targetId, dmg: msg.dmg, dir: msg.dir, isHeavy: msg.isHeavy });
        break;
      }

      case 'stock_lost': {
        const room = rooms.get(roomCode);
        if (!room) return;
        broadcast(room, { type: 'stock_lost', id: playerId, stocks: msg.stocks });
        break;
      }

      case 'match_end': {
        const room = rooms.get(roomCode);
        if (!room) return;
        broadcast(room, { type: 'match_end', winnerId: msg.winnerId });
        room.started = false;
        for (const p of room.players.values()) p.ready = false;
        break;
      }

      case 'leave_room': {
        cleanup();
        break;
      }
    }
  });

  ws.on('close', cleanup);

  function cleanup() {
    if (!roomCode || !playerId) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players.delete(playerId);
    if (room.players.size === 0) {
      rooms.delete(roomCode);
    } else {
      // Reassign host if needed
      if (room.hostId === playerId) {
        room.hostId = room.players.keys().next().value;
      }
      broadcast(room, { type: 'player_left', id: playerId, players: roomSummary(room) });
    }
    roomCode = null;
    playerId = null;
  }
});

server.listen(PORT, () => {
  console.log(`Brawl Arena server listening on port ${PORT}`);
});
