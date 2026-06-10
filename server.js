'use strict';

/* ============================================================
 * server.js — authoritative bughouse server.
 *
 * - Serves the static client (no framework, no build step).
 * - WebSocket rooms identified by 6-character codes.
 * - The server owns all game state: it validates every move,
 *   drop and promotion with the same engine.js the client uses,
 *   runs the clocks, and broadcasts state after every action.
 *   Clients only send intents.
 * ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const {
  ChessBoard, opposite, removableForPromotion, removePromotionPiece,
} = require('./engine.js');

const PORT = process.env.PORT || 8080;
const SEATS = ['A-w', 'A-b', 'B-w', 'B-b'];
const BOARD_IDS = ['A', 'B'];
const ROOM_IDLE_MS = 15 * 60 * 1000;

const teamOf = (boardId, color) => ((boardId === 'A') === (color === 'w') ? 1 : 2);
const otherBoard = id => (id === 'A' ? 'B' : 'A');

/* ---------------- Static file server ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

const httpServer = http.createServer((req, res) => {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(__dirname, urlPath));
  const ext = path.extname(filePath);
  if (!filePath.startsWith(__dirname) || !MIME[ext] || filePath.includes('node_modules')) {
    res.writeHead(404).end('not found');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] });
    res.end(data);
  });
});

/* ---------------- Rooms ---------------- */

const rooms = new Map(); // code -> room

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  let code;
  do {
    code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function createRoom(minutes, inc) {
  const room = {
    code: makeCode(),
    baseMs: minutes * 60000,
    increment: inc * 1000,
    boards: null,
    clocks: null,
    started: false,
    over: null,
    seq: 0,
    seats: { 'A-w': null, 'A-b': null, 'B-w': null, 'B-b': null },
    sockets: new Set(),
    lastTickAt: Date.now(),
    clockSyncCounter: 0,
    lastActivity: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function nameOf(room, boardId, color) {
  const seat = room.seats[`${boardId}-${color}`];
  return seat ? seat.name : '—';
}

function lobbyOf(room) {
  const seats = {};
  for (const s of SEATS) {
    seats[s] = room.seats[s]
      ? { name: room.seats[s].name, connected: room.seats[s].connected }
      : null;
  }
  return { code: room.code, seats, started: room.started };
}

function stateOf(room) {
  const boards = {};
  for (const id of BOARD_IDS) {
    const b = room.boards[id];
    boards[id] = {
      board: b.board, turn: b.turn, castling: b.castling,
      ep: b.ep, reserves: b.reserves, lastMove: b.lastMove,
    };
  }
  const names = { A: {}, B: {} };
  const connected = {};
  for (const s of SEATS) {
    const [bd, c] = s.split('-');
    names[bd][c] = nameOf(room, bd, c);
    connected[s] = !!(room.seats[s] && room.seats[s].connected);
  }
  return {
    boards, clocks: room.clocks, increment: room.increment,
    names, connected, over: room.over, seq: room.seq,
  };
}

function broadcast(room, obj) {
  const data = JSON.stringify(obj);
  for (const ws of room.sockets) {
    if (ws.readyState === 1) ws.send(data);
  }
}

function startRoomGame(room) {
  room.boards = { A: new ChessBoard(), B: new ChessBoard() };
  room.boards.A.promoProvider = c =>
    [...new Set(removableForPromotion(room.boards.B, c).map(x => x.type))];
  room.boards.B.promoProvider = c =>
    [...new Set(removableForPromotion(room.boards.A, c).map(x => x.type))];
  room.clocks = {
    A: { w: room.baseMs, b: room.baseMs },
    B: { w: room.baseMs, b: room.baseMs },
  };
  room.started = true;
  room.over = null;
  room.seq++;
  room.lastTickAt = Date.now();
  room.lastActivity = Date.now();
  broadcast(room, { t: 'start', state: stateOf(room) });
}

function checkEnd(room, boardId) {
  if (room.over) return;
  const board = room.boards[boardId];
  const status = board.status();
  if (status === 'checkmate') {
    room.over = {
      winner: teamOf(boardId, opposite(board.turn)),
      reason: `${nameOf(room, boardId, board.turn)} was checkmated on board ${boardId}.`,
    };
  } else if (status === 'stalemate') {
    room.over = { winner: 0, reason: `Stalemate on board ${boardId}.` };
  }
}

function afterAction(room, boardId, mover, captured) {
  room.clocks[boardId][mover] += room.increment;
  if (captured) {
    room.boards[otherBoard(boardId)].reserves[captured.color][captured.type]++;
  }
  checkEnd(room, boardId);
  room.seq++;
  room.lastActivity = Date.now();
  broadcast(room, { t: 'state', state: stateOf(room) });
}

/* ---------------- Clock loop ---------------- */

setInterval(() => {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    if (room.started && !room.over) {
      const dt = now - room.lastTickAt;
      for (const id of BOARD_IDS) {
        const color = room.boards[id].turn;
        room.clocks[id][color] -= dt;
        if (room.clocks[id][color] <= 0) {
          room.clocks[id][color] = 0;
          const loserTeam = teamOf(id, color);
          room.over = {
            winner: loserTeam === 1 ? 2 : 1,
            reason: `${nameOf(room, id, color)} ran out of time on board ${id}.`,
          };
          room.seq++;
          broadcast(room, { t: 'state', state: stateOf(room) });
          break;
        }
      }
      room.clockSyncCounter++;
      if (!room.over && room.clockSyncCounter % 10 === 0) {
        broadcast(room, { t: 'clocks', clocks: room.clocks });
      }
    }
    room.lastTickAt = now;

    // drop rooms nobody is connected to anymore
    const anyConnected = [...room.sockets].some(ws => ws.readyState === 1);
    if (anyConnected) room.lastActivity = now;
    else if (now - room.lastActivity > ROOM_IDLE_MS) rooms.delete(room.code);
  }
}, 100);

/* ---------------- WebSocket handling ---------------- */

const wss = new WebSocketServer({ server: httpServer });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
function sendErr(ws, msg) { send(ws, { t: 'error', msg }); }

function roomOf(ws) {
  return ws.meta && ws.meta.code ? rooms.get(ws.meta.code) : null;
}

function releaseSeat(room, ws) {
  for (const s of SEATS) {
    if (room.seats[s] && room.seats[s].ws === ws) room.seats[s] = null;
  }
}

const clamp = (x, lo, hi, dflt) => {
  const n = Number(x);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};
const cleanName = n => String(n || '').trim().slice(0, 14) || 'Anon';
const idx = x => {
  const n = Number(x);
  return Number.isInteger(n) && n >= 0 && n < 8 ? n : null;
};

wss.on('connection', ws => {
  ws.meta = { code: null, seat: null, name: 'Anon' };

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }
    try { handle(ws, msg); } catch (e) {
      console.error('handler error:', e);
      sendErr(ws, 'server error');
    }
  });

  ws.on('close', () => {
    const room = roomOf(ws);
    if (!room) return;
    room.sockets.delete(ws);
    if (ws.meta.seat && room.seats[ws.meta.seat] && room.seats[ws.meta.seat].ws === ws) {
      room.seats[ws.meta.seat].connected = false;
      room.seats[ws.meta.seat].ws = null;
      if (room.started) {
        room.seq++;
        broadcast(room, { t: 'state', state: stateOf(room) });
      } else {
        // free the seat entirely while still in the lobby
        room.seats[ws.meta.seat] = null;
        broadcast(room, { t: 'lobby', lobby: lobbyOf(room) });
      }
    }
  });
});

function handle(ws, msg) {
  switch (msg.t) {
    case 'create': {
      const minutes = clamp(msg.minutes, 0.1, 180, 5);
      const inc = clamp(msg.inc, 0, 60, 0);
      const room = createRoom(minutes, inc);
      ws.meta.code = room.code;
      ws.meta.name = cleanName(msg.name);
      room.sockets.add(ws);
      send(ws, { t: 'joined', code: room.code, lobby: lobbyOf(room) });
      return;
    }

    case 'join': {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase());
      if (!room) return sendErr(ws, 'No game with that code.');
      if (room.started) return sendErr(ws, 'That game has already started.');
      ws.meta.code = room.code;
      ws.meta.name = cleanName(msg.name);
      room.sockets.add(ws);
      send(ws, { t: 'joined', code: room.code, lobby: lobbyOf(room) });
      broadcast(room, { t: 'lobby', lobby: lobbyOf(room) });
      return;
    }

    case 'sit': {
      const room = roomOf(ws);
      if (!room || room.started) return;
      const seat = String(msg.seat);
      if (!SEATS.includes(seat)) return;
      const cur = room.seats[seat];
      if (cur && cur.ws && cur.ws !== ws) return sendErr(ws, 'Seat already taken.');
      releaseSeat(room, ws);
      const token = crypto.randomBytes(12).toString('hex');
      room.seats[seat] = { name: ws.meta.name, ws, token, connected: true };
      ws.meta.seat = seat;
      send(ws, { t: 'seat', seat, token, code: room.code });
      broadcast(room, { t: 'lobby', lobby: lobbyOf(room) });
      if (SEATS.every(s => room.seats[s])) startRoomGame(room);
      return;
    }

    case 'rejoin': {
      const room = rooms.get(String(msg.code || '').trim().toUpperCase());
      const seat = String(msg.seat);
      if (!room || !SEATS.includes(seat)) return sendErr(ws, 'Game no longer exists.');
      const s = room.seats[seat];
      if (!s || s.token !== msg.token) return sendErr(ws, 'Could not rejoin.');
      s.ws = ws;
      s.connected = true;
      ws.meta = { code: room.code, seat, name: s.name };
      room.sockets.add(ws);
      if (room.started) {
        send(ws, { t: 'rejoined', seat, state: stateOf(room) });
        room.seq++;
        broadcast(room, { t: 'state', state: stateOf(room) });
      } else {
        send(ws, { t: 'joined', code: room.code, lobby: lobbyOf(room) });
        broadcast(room, { t: 'lobby', lobby: lobbyOf(room) });
      }
      return;
    }

    case 'move': {
      const room = roomOf(ws);
      if (!room || !room.started || room.over || !ws.meta.seat) return;
      const [bd, color] = ws.meta.seat.split('-');
      if (msg.board !== bd) return sendErr(ws, 'Not your board.');
      const board = room.boards[bd];
      if (board.turn !== color) return sendErr(ws, 'Not your turn.');
      const fromR = idx(msg.fromR), fromF = idx(msg.fromF);
      const toR = idx(msg.toR), toF = idx(msg.toF);
      if (fromR === null || fromF === null || toR === null || toF === null) return;
      const piece = board.get(fromR, fromF);
      if (!piece || piece.color !== color) return sendErr(ws, 'Illegal move.');
      const move = board.legalMovesFrom(fromR, fromF)
        .find(m => m.toR === toR && m.toF === toF);
      if (!move) return sendErr(ws, 'Illegal move.');
      if (move.promo) {
        const cand = msg.cand;
        const cands = removableForPromotion(room.boards[otherBoard(bd)], color);
        const valid = cand && cands.some(c => c.r === cand.r && c.f === cand.f && c.type === cand.type)
          && msg.promoType === cand.type;
        if (!valid) return sendErr(ws, 'Invalid promotion choice.');
        removePromotionPiece(room.boards[otherBoard(bd)], { r: cand.r, f: cand.f, type: cand.type });
        checkEnd(room, otherBoard(bd));
        if (room.over) {
          room.seq++;
          broadcast(room, { t: 'state', state: stateOf(room) });
          return;
        }
      }
      const { captured } = board.makeMove({ ...move, promoType: msg.promoType });
      afterAction(room, bd, color, captured);
      return;
    }

    case 'drop': {
      const room = roomOf(ws);
      if (!room || !room.started || room.over || !ws.meta.seat) return;
      const [bd, color] = ws.meta.seat.split('-');
      if (msg.board !== bd) return sendErr(ws, 'Not your board.');
      const board = room.boards[bd];
      if (board.turn !== color) return sendErr(ws, 'Not your turn.');
      const r = idx(msg.r), f = idx(msg.f);
      const type = String(msg.type);
      if (r === null || f === null || !['p', 'n', 'b', 'r', 'q'].includes(type)) return;
      if (board.reserves[color][type] <= 0 || !board.isDropLegal(color, type, r, f)) {
        return sendErr(ws, 'Illegal drop.');
      }
      board.makeDrop(color, type, r, f);
      afterAction(room, bd, color, null);
      return;
    }

    case 'request': {
      const room = roomOf(ws);
      if (!room || !room.started || room.over || !ws.meta.seat) return;
      const type = String(msg.type);
      if (!['p', 'n', 'b', 'r', 'q'].includes(type)) return;
      broadcast(room, { t: 'request', seat: ws.meta.seat, type });
      return;
    }

    case 'rematch': {
      const room = roomOf(ws);
      if (!room || !room.started || !room.over) return;
      startRoomGame(room);
      return;
    }
  }
}

httpServer.listen(PORT, () => {
  console.log(`Bughouse server listening on http://localhost:${PORT}`);
});
