'use strict';
/* global ChessBoard, opposite, sqName, onBoard, removableForPromotion, removePromotionPiece,
   KNIGHT_OFFSETS, KING_OFFSETS, ROOK_DIRS, BISHOP_DIRS */

/* ============================================================
 * app.js — bughouse client. Two modes:
 *
 *  - local:  the full game runs in this browser (hotseat).
 *  - online: the server owns the game; this client renders the
 *    broadcast state and sends move/drop intents. The same
 *    engine.js runs here for highlights, drop targets and
 *    premove validation.
 *
 * Teams: Team 1 = White on board A + Black on board B.
 *        Team 2 = Black on board A + White on board B.
 * ============================================================ */

const RESERVE_ORDER = ['p', 'n', 'b', 'r', 'q'];
const BOARD_IDS = ['A', 'B'];
const COLORS = ['w', 'b'];
const PIECE_NAMES = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const PROMO_TYPES = ['q', 'r', 'b', 'n'];
const SEAT_LABELS = {
  'A-w': 'White · Board A', 'B-b': 'Black · Board B',
  'A-b': 'Black · Board A', 'B-w': 'White · Board B',
};

const TC_PRESETS = [
  { label: '1+0', min: 1, inc: 0 },
  { label: '2+1', min: 2, inc: 1 },
  { label: '3+0', min: 3, inc: 0 },
  { label: '3+2', min: 3, inc: 2 },
  { label: '5+0', min: 5, inc: 0 },
  { label: '5+5', min: 5, inc: 5 },
  { label: '10+0', min: 10, inc: 0 },
];

const teamOf = (boardId, color) => ((boardId === 'A') === (color === 'w') ? 1 : 2);
const otherBoard = id => (id === 'A' ? 'B' : 'A');

const Game = {
  boards: null,
  clocks: null,
  increment: 0,
  names: null,
  connected: null,                    // online: seat -> bool
  over: null,
  selected: { A: null, B: null },     // side-to-move selection
  preSel: { A: null, B: null },       // waiting player's premove selection
  premove: { A: null, B: null },      // queued premove per board
  requests: { A: null, B: null },
  badges: {},
  pendingPromo: null,
  timer: null,
  lastTick: 0,
  lastSeq: -1,
  domBuilt: false,
};

/* Board orientation: which color sits at the bottom of each board,
 * and which board is shown on the left (your own, when online). */
const View = { flipped: { A: false, B: true } };

const Net = {
  mode: 'local',          // 'local' | 'online'
  ws: null,
  code: null,
  seat: null,             // 'A-w' etc.
  token: null,
  name: '',
  reconnecting: false,
};

let dragState = null;
let ghostRef = null;

const $ = sel => document.querySelector(sel);

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function pieceClasses(color, type) {
  return `${color} ${type} ${color}${type}`;
}

function pieceImg(color, type, cls, parent) {
  return el('span', `pimg ${pieceClasses(color, type)}${cls ? ' ' + cls : ''}`, parent);
}

function squareEl(boardId, r, f) {
  return $(`#board-${boardId} .square[data-r="${r}"][data-f="${f}"]`);
}

/* In online mode you may only act for your own seat. */
function canAct(boardId, color) {
  if (Net.mode !== 'online') return true;
  return Net.seat === `${boardId}-${color}`;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 3000);
}

/* ---------------- Sound ---------------- */

let audioCtx = null;
function beep(freq, dur, delay = 0, vol = 0.06) {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const t = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    osc.type = 'sine';
    gain.gain.setValueAtTime(vol, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t);
    osc.stop(t + dur);
  } catch (e) { /* audio is optional */ }
}
const soundMove = () => beep(240, 0.07);
const soundRequest = () => { beep(660, 0.12); beep(880, 0.12, 0.14); };
const soundEnd = () => { beep(520, 0.18); beep(390, 0.25, 0.2); };

/* ---------------- DOM construction ---------------- */

function buildDOM() {
  if (Game.domBuilt) return;
  Game.domBuilt = true;

  for (const id of BOARD_IDS) {
    buildBoardSquares(id);
    const boardEl = $(`#board-${id}`);
    boardEl.addEventListener('contextmenu', ev => {
      ev.preventDefault();
      Game.premove[id] = null;
      Game.preSel[id] = null;
      Game.selected[id] = null;
      render();
    });
    for (const color of COLORS) buildPanel(id, color);
  }

  document.addEventListener('pointermove', onPointerMove);
  document.addEventListener('pointerup', onPointerUp);
  document.addEventListener('pointercancel', onPointerCancel);

  $('#newgame-btn').addEventListener('click', () => { leaveOnline(); showSetup(); });
  $('#rematch-btn').addEventListener('click', () => {
    $('#gameover').classList.add('hidden');
    if (Net.mode === 'online') netSend({ t: 'rematch' });
    else startLocalGame();
  });
  $('#tosetup-btn').addEventListener('click', () => {
    $('#gameover').classList.add('hidden');
    leaveOnline();
    showSetup();
  });
  $('#promo').addEventListener('click', e => {
    if (e.target === $('#promo')) { Game.pendingPromo = null; $('#promo').classList.add('hidden'); render(); }
  });
}

/* Squares are rebuilt whenever the orientation changes. */
function buildBoardSquares(id) {
  const boardEl = $(`#board-${id}`);
  boardEl.innerHTML = '';
  const flipped = View.flipped[id];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const sq = el('div', `square ${(r + f) % 2 === 0 ? 'dark' : 'light'}`, boardEl);
      sq.dataset.r = r;
      sq.dataset.f = f;
      sq.style.gridRowStart = flipped ? r + 1 : 8 - r;
      sq.style.gridColumnStart = flipped ? 8 - f : f + 1;
      const bottomRank = flipped ? 7 : 0;
      const edgeFile = flipped ? 0 : 7;
      if (r === bottomRank) el('span', 'coord file', sq).textContent = 'abcdefgh'[f];
      if (f === edgeFile) el('span', 'coord rank', sq).textContent = r + 1;
      el('span', 'piece pimg', sq);
      sq.addEventListener('pointerdown', ev => onSquarePointerDown(id, r, f, ev));
      sq.addEventListener('pointerenter', () => onSquareHover(id, r, f));
      sq.addEventListener('pointerleave', () => onSquareLeave(id, r, f));
    }
  }
}

/* viewTeam's players sit at the bottom; ownBoardId is shown on the left. */
function setOrientation(viewTeam, ownBoardId) {
  View.flipped.A = viewTeam === 2;
  View.flipped.B = viewTeam === 1;
  $('#col-A').style.order = ownBoardId === 'A' ? 0 : 1;
  $('#col-B').style.order = ownBoardId === 'B' ? 0 : 1;
  for (const id of BOARD_IDS) {
    buildBoardSquares(id);
    const bottomColor = View.flipped[id] ? 'b' : 'w';
    $(`#panel-${id}-${bottomColor}`).style.order = 3;
    $(`#panel-${id}-${opposite(bottomColor)}`).style.order = 1;
    $(`#board-${id}`).style.order = 2;
  }
}

function buildPanel(boardId, color) {
  const panel = $(`#panel-${boardId}-${color}`);
  panel.innerHTML = '';
  panel.classList.add(`team${teamOf(boardId, color)}`);

  const line = el('div', 'player-line', panel);
  const tag = el('span', `team-tag team${teamOf(boardId, color)}`, line);
  tag.textContent = `T${teamOf(boardId, color)}`;
  el('span', 'pname', line).id = `pname-${boardId}-${color}`;
  const badge = el('span', 'req-badge', line);
  badge.id = `badge-${boardId}-${color}`;
  const clock = el('span', 'clock', line);
  clock.id = `clock-${boardId}-${color}`;

  const resRow = el('div', 'panel-row', panel);
  el('span', 'row-label', resRow).textContent = 'Reserve';
  const reserve = el('div', 'reserve', resRow);
  reserve.id = `reserve-${boardId}-${color}`;
  for (const type of RESERVE_ORDER) {
    const chip = el('span', 'chip', reserve);
    chip.dataset.type = type;
    pieceImg(color, type, 'chip-piece', chip);
    el('span', 'cnt', chip).textContent = '0';
    chip.addEventListener('pointerdown', ev => onReservePointerDown(boardId, color, type, ev));
  }

  const reqRow = el('div', 'panel-row ask-row', panel);
  el('span', 'row-label', reqRow).textContent = 'Ask for';
  const btns = el('div', 'req-btns', reqRow);
  for (const type of RESERVE_ORDER) {
    const b = el('button', null, btns);
    pieceImg(color, type, 'btn-piece', b);
    b.title = `Ask your teammate for a ${PIECE_NAMES[type]}`;
    b.addEventListener('click', () => sendRequest(boardId, color, type));
  }
}

/* ---------------- Setup screen ---------------- */

function initSetup() {
  const presets = $('#tc-presets');
  TC_PRESETS.forEach((p, i) => {
    const b = el('button', i === 4 ? 'active' : null, presets); // default 5+0
    b.textContent = p.label;
    b.addEventListener('click', () => {
      presets.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      b.classList.add('active');
      $('#tc-min').value = p.min;
      $('#tc-inc').value = p.inc;
    });
  });
  const clearActive = () => presets.querySelectorAll('button').forEach(x => x.classList.remove('active'));
  $('#tc-min').addEventListener('input', clearActive);
  $('#tc-inc').addEventListener('input', clearActive);

  $('#start-btn').addEventListener('click', () => { buildDOM(); startLocalGame(); });
  $('#create-btn').addEventListener('click', () => goOnline(ws =>
    netSend({
      t: 'create',
      name: $('#online-name').value,
      minutes: parseFloat($('#tc-min').value) || 5,
      inc: parseFloat($('#tc-inc').value) || 0,
    })));
  $('#join-btn').addEventListener('click', () => goOnline(ws =>
    netSend({ t: 'join', code: $('#join-code').value, name: $('#online-name').value })));
  $('#join-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') $('#join-btn').click();
  });
  $('#lobby-leave').addEventListener('click', () => { leaveOnline(); showSetup(); });
}

function showSetup() {
  stopClock();
  $('#game').classList.add('hidden');
  $('#lobby').classList.add('hidden');
  $('#gameover').classList.add('hidden');
  $('#setup').classList.remove('hidden');
}

function playerName(boardId, color) {
  return Game.names[boardId][color];
}

function resetMatchState() {
  Game.over = null;
  Game.selected = { A: null, B: null };
  Game.preSel = { A: null, B: null };
  Game.premove = { A: null, B: null };
  Game.requests = { A: null, B: null };
  Game.badges = {};
  Game.pendingPromo = null;
  Game.connected = null;
  Game.lastSeq = -1;
  dragState = null;
  ghostRef = null;
  $('#promo').classList.add('hidden');
  $('#gameover').classList.add('hidden');
}

function startLocalGame() {
  Net.mode = 'local';
  const minutes = Math.max(0.1, parseFloat($('#tc-min').value) || 5);
  const incSec = Math.max(0, parseFloat($('#tc-inc').value) || 0);

  Game.boards = { A: new ChessBoard(), B: new ChessBoard() };
  wirePromoProviders();
  const base = minutes * 60000;
  Game.clocks = { A: { w: base, b: base }, B: { w: base, b: base } };
  Game.increment = incSec * 1000;
  Game.names = {
    A: { w: $('#name-A-w').value.trim() || 'Player 1', b: $('#name-A-b').value.trim() || 'Player 3' },
    B: { w: $('#name-B-w').value.trim() || 'Player 4', b: $('#name-B-b').value.trim() || 'Player 2' },
  };
  resetMatchState();
  setOrientation(1, 'A');
  enterGameScreen('');
  render();
  startClock();
}

function wirePromoProviders() {
  for (const id of BOARD_IDS) {
    Game.boards[id].promoProvider = color =>
      [...new Set(promoCandidates(id, color).map(c => c.type))];
  }
}

function enterGameScreen(netLabel) {
  for (const id of BOARD_IDS) {
    for (const c of COLORS) {
      $(`#pname-${id}-${c}`).textContent = playerName(id, c);
    }
  }
  $('#matchup').textContent =
    `Team 1: ${playerName('A', 'w')} & ${playerName('B', 'b')}  vs  Team 2: ${playerName('A', 'b')} & ${playerName('B', 'w')}`;
  $('#net-status').textContent = netLabel;
  $('#setup').classList.add('hidden');
  $('#lobby').classList.add('hidden');
  $('#game').classList.remove('hidden');
}

/* ---------------- Networking ---------------- */

function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

function goOnline(onReady) {
  if (location.protocol === 'file:') {
    toast('Online play needs the server — run "npm start" and open http://localhost:8080');
    return;
  }
  buildDOM();
  if (Net.ws && Net.ws.readyState === 1) { onReady(Net.ws); return; }
  const ws = new WebSocket(wsURL());
  Net.ws = ws;
  ws.onopen = () => onReady(ws);
  ws.onmessage = onNetMessage;
  ws.onclose = () => onNetClose(ws);
  ws.onerror = () => {};
}

function netSend(obj) {
  if (Net.ws && Net.ws.readyState === 1) Net.ws.send(JSON.stringify(obj));
}

function leaveOnline() {
  if (Net.ws) {
    Net.ws.onclose = null;
    try { Net.ws.close(); } catch (e) { /* ignore */ }
  }
  Net.ws = null;
  Net.mode = 'local';
  Net.code = null;
  Net.seat = null;
  Net.token = null;
  Net.reconnecting = false;
  sessionStorage.removeItem('bughouse-session');
}

function onNetClose(ws) {
  if (Net.ws !== ws) return;
  // try to rejoin a running game
  if (Net.mode === 'online' && Net.code && Net.seat && Net.token && !Game.over) {
    Net.reconnecting = true;
    $('#net-status').textContent = '⚠ reconnecting…';
    setTimeout(() => {
      if (!Net.reconnecting) return;
      const nws = new WebSocket(wsURL());
      Net.ws = nws;
      nws.onopen = () => netSend({ t: 'rejoin', code: Net.code, seat: Net.seat, token: Net.token });
      nws.onmessage = onNetMessage;
      nws.onclose = () => onNetClose(nws);
      nws.onerror = () => {};
    }, 1500);
  }
}

function netStatusLabel() {
  return `● room ${Net.code} — you are ${SEAT_LABELS[Net.seat] || 'spectating'}`;
}

function onNetMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch (e) { return; }

  switch (msg.t) {
    case 'joined':
      Net.mode = 'online';
      Net.code = msg.code;
      showLobby(msg.lobby);
      return;

    case 'lobby':
      if (!$('#lobby').classList.contains('hidden')) showLobby(msg.lobby);
      return;

    case 'seat':
      Net.seat = msg.seat;
      Net.token = msg.token;
      sessionStorage.setItem('bughouse-session',
        JSON.stringify({ code: Net.code, seat: msg.seat, token: msg.token }));
      return;

    case 'start':
    case 'rejoined': {
      Net.mode = 'online';
      Net.reconnecting = false;
      if (msg.seat) Net.seat = msg.seat;
      resetMatchState();
      applyServerState(msg.state);
      const [bd, c] = Net.seat.split('-');
      setOrientation(teamOf(bd, c), bd);
      enterGameScreen(netStatusLabel());
      render();
      startClock();
      return;
    }

    case 'state':
      if (Net.reconnecting) return;
      applyServerState(msg.state);
      render();
      maybeRunPremoveOnline();
      return;

    case 'clocks':
      if (!Game.clocks) return;
      Game.clocks = msg.clocks;
      Game.lastTick = performance.now();
      renderClocks();
      return;

    case 'request': {
      const [bd, c] = msg.seat.split('-');
      const mateBoard = otherBoard(bd);
      const mateColor = opposite(c);
      const until = Date.now() + 8000;
      Game.requests[mateBoard] = { type: msg.type, color: c, until };
      Game.badges[`${mateBoard}-${mateColor}`] = { type: msg.type, color: c, until };
      if (Net.seat === `${mateBoard}-${mateColor}`) soundRequest();
      render();
      setTimeout(render, 8200);
      return;
    }

    case 'error':
      toast(msg.msg);
      render();
      return;
  }
}

function showLobby(lobby) {
  $('#setup').classList.add('hidden');
  $('#game').classList.add('hidden');
  $('#lobby').classList.remove('hidden');
  $('#lobby-code').textContent = lobby.code;

  const wrap = $('#lobby-seats');
  wrap.innerHTML = '';
  for (const teamNum of [1, 2]) {
    const box = el('div', `lobby-team team${teamNum}`, wrap);
    el('h4', null, box).textContent = `Team ${teamNum}`;
    const seats = teamNum === 1 ? ['A-w', 'B-b'] : ['A-b', 'B-w'];
    for (const seat of seats) {
      const btn = el('button', 'seat-btn', box);
      const occ = lobby.seats[seat];
      el('span', 'seat-label', btn).textContent = SEAT_LABELS[seat];
      const who = el('span', 'seat-name', btn);
      if (occ) {
        who.textContent = occ.name + (occ.connected ? '' : ' ⚠');
        btn.classList.add('taken');
        if (seat === Net.seat) btn.classList.add('mine');
      } else {
        who.textContent = 'Take this seat';
        btn.addEventListener('click', () => netSend({ t: 'sit', seat }));
      }
    }
  }
  const taken = Object.values(lobby.seats).filter(Boolean).length;
  $('#lobby-status').textContent = taken === 4
    ? 'Starting…'
    : `Waiting for players… (${taken}/4 seats taken)`;
}

/* Rebuild local ChessBoard mirrors from the server state. */
function applyServerState(state) {
  const prevSeq = Game.lastSeq;
  if (!Game.boards) Game.boards = {};
  for (const id of BOARD_IDS) {
    const s = state.boards[id];
    const b = new ChessBoard();
    b.board = s.board;
    b.turn = s.turn;
    b.castling = s.castling;
    b.ep = s.ep;
    b.reserves = s.reserves;
    b.lastMove = s.lastMove;
    Game.boards[id] = b;
  }
  wirePromoProviders();
  Game.clocks = state.clocks;
  Game.increment = state.increment;
  Game.names = state.names;
  Game.connected = state.connected;
  Game.lastSeq = state.seq;
  Game.lastTick = performance.now();

  // an action happened: clear stale turn-selections and play a sound
  if (prevSeq >= 0 && state.seq > prevSeq) {
    Game.selected = { A: null, B: null };
    if (!state.over) soundMove();
  }

  if (state.over && !Game.over) {
    Game.over = state.over;
    Game.premove = { A: null, B: null };
    Game.preSel = { A: null, B: null };
    Game.pendingPromo = null;
    $('#promo').classList.add('hidden');
    stopClock();
    presentGameOver(state.over.winner, state.over.reason);
  } else if (!state.over) {
    Game.over = null;
  }
}

function maybeRunPremoveOnline() {
  if (Net.mode !== 'online' || Game.over || !Net.seat) return;
  const [bd, c] = Net.seat.split('-');
  if (Game.boards[bd].turn === c && Game.premove[bd]) {
    setTimeout(() => executePremove(bd), 60);
  }
}

/* ---------------- Game init helpers ---------------- */

function startClock() {
  stopClock();
  Game.lastTick = performance.now();
  Game.timer = setInterval(tick, 100);
  renderClocks();
}

function stopClock() {
  if (Game.timer) { clearInterval(Game.timer); Game.timer = null; }
}

function tick() {
  const now = performance.now();
  const dt = now - Game.lastTick;
  Game.lastTick = now;
  if (Game.over) return;

  for (const id of BOARD_IDS) {
    const color = Game.boards[id].turn;
    Game.clocks[id][color] -= dt;
    if (Game.clocks[id][color] <= 0) {
      Game.clocks[id][color] = 0;
      if (Net.mode === 'local') {
        const loserTeam = teamOf(id, color);
        endGameLocal(loserTeam === 1 ? 2 : 1,
          `${playerName(id, color)} ran out of time on board ${id}.`);
        renderClocks();
        return;
      }
      // online: the server decides flag falls; we just clamp at 0
    }
  }
  renderClocks();
}

function formatClock(ms) {
  if (ms < 0) ms = 0;
  const total = ms / 1000;
  const m = Math.floor(total / 60);
  const s = Math.floor(total % 60);
  if (total < 20) {
    const tenths = Math.floor((total - Math.floor(total)) * 10);
    return `${m}:${String(s).padStart(2, '0')}.${tenths}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderClocks() {
  for (const id of BOARD_IDS) {
    for (const c of COLORS) {
      const elc = $(`#clock-${id}-${c}`);
      const ms = Game.clocks[id][c];
      elc.textContent = formatClock(ms);
      elc.classList.toggle('active', !Game.over && Game.boards[id].turn === c);
      elc.classList.toggle('low', ms < 30000);
    }
  }
}

/* ---------------- Premoves ---------------- */

function premoveTargets(board, r, f) {
  const piece = board.get(r, f);
  if (!piece) return [];
  const out = [];
  const push = (rr, ff) => { if (onBoard(rr, ff)) out.push({ r: rr, f: ff }); };

  if (piece.type === 'p') {
    const dir = piece.color === 'w' ? 1 : -1;
    const startRank = piece.color === 'w' ? 1 : 6;
    push(r + dir, f);
    if (r === startRank) push(r + 2 * dir, f);
    push(r + dir, f - 1);
    push(r + dir, f + 1);
  } else if (piece.type === 'n' || piece.type === 'k') {
    const offsets = piece.type === 'n' ? KNIGHT_OFFSETS : KING_OFFSETS;
    for (const [dr, df] of offsets) push(r + dr, f + df);
    if (piece.type === 'k' && f === 4) { push(r, 6); push(r, 2); } // castling
  } else {
    const dirs = piece.type === 'r' ? ROOK_DIRS
      : piece.type === 'b' ? BISHOP_DIRS
      : [...ROOK_DIRS, ...BISHOP_DIRS];
    for (const [dr, df] of dirs) {
      let rr = r + dr, ff = f + df;
      while (onBoard(rr, ff)) { out.push({ r: rr, f: ff }); rr += dr; ff += df; }
    }
  }
  return out;
}

function queuePremove(boardId, pm) {
  Game.premove[boardId] = pm;
  Game.preSel[boardId] = null;
  render();
}

function executePremove(boardId) {
  const pm = Game.premove[boardId];
  if (!pm || Game.over || Game.pendingPromo) return;
  const board = Game.boards[boardId];
  if (board.turn !== pm.color) return;
  Game.premove[boardId] = null;

  if (pm.kind === 'move') {
    const piece = board.get(pm.fromR, pm.fromF);
    if (piece && piece.color === pm.color) {
      const move = board.legalMovesFrom(pm.fromR, pm.fromF)
        .find(m => m.toR === pm.toR && m.toF === pm.toF);
      if (move) {
        if (move.promo) {
          const pick = autoPromoPick(boardId, pm.color);
          if (pick) { requestMove(boardId, move, pick.type, pick); return; }
        } else {
          requestMove(boardId, move);
          return;
        }
      }
    }
  } else if (pm.kind === 'drop') {
    if (board.reserves[pm.color][pm.type] > 0
      && board.isDropLegal(pm.color, pm.type, pm.r, pm.f)) {
      requestDrop(boardId, pm.color, pm.type, pm.r, pm.f);
      return;
    }
  }
  render(); // premove was illegal — silently cancelled
}

/* ---------------- Promotion ---------------- */

function promoCandidates(boardId, color) {
  return removableForPromotion(Game.boards[otherBoard(boardId)], color);
}

function autoPromoPick(boardId, color) {
  const cands = promoCandidates(boardId, color);
  for (const type of PROMO_TYPES) { // q > r > b > n
    const c = cands.find(x => x.type === type);
    if (c) return c;
  }
  return null;
}

function openPromoDialog(boardId, move) {
  const color = Game.boards[boardId].turn;
  const cands = promoCandidates(boardId, color);
  if (cands.length === 0) return; // shouldn't happen: move was filtered
  Game.pendingPromo = { boardId, move };
  const choices = $('#promo-choices');
  choices.innerHTML = '';
  for (const c of cands) {
    const b = el('button', 'promo-cand', choices);
    pieceImg(color, c.type, 'promo-piece', b);
    el('span', 'promo-sq', b).textContent = sqName(c.r, c.f);
    b.addEventListener('click', () => {
      const { boardId: id, move: m } = Game.pendingPromo;
      Game.pendingPromo = null;
      $('#promo').classList.add('hidden');
      requestMove(id, m, c.type, c);
    });
  }
  $('#promo').classList.remove('hidden');
}

/* ---------------- Actions (local execution or online intent) ---------------- */

function requestMove(boardId, move, promoType, cand) {
  Game.selected[boardId] = null;
  if (Net.mode === 'online') {
    netSend({
      t: 'move', board: boardId,
      fromR: move.fromR, fromF: move.fromF, toR: move.toR, toF: move.toF,
      promoType, cand: cand ? { r: cand.r, f: cand.f, type: cand.type } : undefined,
    });
    render();
    return;
  }
  if (cand) {
    removePromotionPiece(Game.boards[otherBoard(boardId)], cand);
    checkBoardEnd(otherBoard(boardId));
  }
  if (Game.over) { render(); return; }
  const board = Game.boards[boardId];
  const mover = board.turn;
  const { captured } = board.makeMove({ ...move, promoType });
  afterActionLocal(boardId, mover, captured);
}

function requestDrop(boardId, color, type, r, f) {
  Game.selected[boardId] = null;
  if (Net.mode === 'online') {
    netSend({ t: 'drop', board: boardId, type, r, f });
    render();
    return;
  }
  const board = Game.boards[boardId];
  const mover = board.turn;
  board.makeDrop(color, type, r, f);
  afterActionLocal(boardId, mover, null);
}

function checkBoardEnd(boardId) {
  if (Game.over) return;
  const board = Game.boards[boardId];
  const status = board.status();
  if (status === 'checkmate') {
    endGameLocal(teamOf(boardId, opposite(board.turn)),
      `${playerName(boardId, board.turn)} was checkmated on board ${boardId}.`);
  } else if (status === 'stalemate') {
    endGameLocal(0, `Stalemate on board ${boardId}.`);
  }
}

function afterActionLocal(boardId, mover, captured) {
  Game.clocks[boardId][mover] += Game.increment;
  ghostRef = null;

  if (captured) {
    Game.boards[otherBoard(boardId)].reserves[captured.color][captured.type]++;
  }

  soundMove();
  checkBoardEnd(boardId);
  render();

  if (!Game.over && Game.premove[boardId]) {
    setTimeout(() => executePremove(boardId), 80);
  }
}

/* ---------------- Pointer interaction ---------------- */

function onSquarePointerDown(boardId, r, f, ev) {
  if (Game.over || Game.pendingPromo || !Game.boards) return;
  ev.preventDefault();
  const board = Game.boards[boardId];
  const sel = Game.selected[boardId];
  const pre = Game.preSel[boardId];
  const pm = Game.premove[boardId];
  const piece = board.get(r, f);

  // 1. side-to-move drop
  if (sel && sel.kind === 'drop' && sel.squares.some(s => s.r === r && s.f === f)) {
    requestDrop(boardId, sel.color, sel.type, r, f);
    return;
  }
  // 2. side-to-move move
  if (sel && sel.kind === 'square') {
    const move = sel.moves.find(m => m.toR === r && m.toF === f);
    if (move) {
      if (move.promo) openPromoDialog(boardId, move);
      else requestMove(boardId, move);
      return;
    }
  }
  // 3. side-to-move picks up a piece (priority over premove targeting)
  if (piece && piece.color === board.turn && canAct(boardId, piece.color)) {
    const wasSelected = !!(sel && sel.kind === 'square' && sel.r === r && sel.f === f);
    Game.selected[boardId] = { kind: 'square', r, f, moves: board.legalMovesFrom(r, f) };
    render();
    dragState = {
      mode: 'move', boardId, r, f,
      color: piece.color, type: piece.type,
      startX: ev.clientX, startY: ev.clientY,
      active: false, toggleOff: wasSelected, hoverEl: null,
    };
    return;
  }
  // 4. waiting player picks up their piece -> premove selection
  if (piece && piece.color !== board.turn && canAct(boardId, piece.color)) {
    const wasSelected = !!(pre && pre.kind === 'pre-square' && pre.r === r && pre.f === f);
    const targets = premoveTargets(board, r, f);
    Game.preSel[boardId] = { kind: 'pre-square', r, f, color: piece.color, targets };
    render();
    dragState = {
      mode: 'premove', boardId, r, f,
      color: piece.color, type: piece.type, targets,
      startX: ev.clientX, startY: ev.clientY,
      active: false, toggleOff: wasSelected, hoverEl: null,
    };
    return;
  }
  // 5. queue a premove onto an empty square
  if (pre && pre.kind === 'pre-square' && pre.targets.some(t => t.r === r && t.f === f)) {
    queuePremove(boardId, { kind: 'move', color: pre.color, fromR: pre.r, fromF: pre.f, toR: r, toF: f });
    return;
  }
  if (pre && pre.kind === 'pre-drop'
    && (pre.type !== 'p' || ChessBoard.pawnDropAllowed(pre.color, r))) {
    queuePremove(boardId, { kind: 'drop', color: pre.color, type: pre.type, r, f });
    return;
  }
  // 6. empty click: clear selections; clicking a premove square cancels it
  if (pm && ((pm.kind === 'move' && ((pm.fromR === r && pm.fromF === f) || (pm.toR === r && pm.toF === f)))
    || (pm.kind === 'drop' && pm.r === r && pm.f === f))) {
    Game.premove[boardId] = null;
  }
  Game.selected[boardId] = null;
  Game.preSel[boardId] = null;
  render();
}

function onReservePointerDown(boardId, color, type, ev) {
  if (Game.over || Game.pendingPromo || !Game.boards) return;
  ev.preventDefault();
  if (!canAct(boardId, color)) return;
  const board = Game.boards[boardId];
  if (board.reserves[color][type] <= 0) return;

  if (board.turn === color) {
    const sel = Game.selected[boardId];
    const wasSelected = !!(sel && sel.kind === 'drop' && sel.type === type);
    Game.selected[boardId] = { kind: 'drop', type, color, squares: board.legalDropSquares(color, type) };
    render();
    dragState = {
      mode: 'drop', boardId, color, type,
      startX: ev.clientX, startY: ev.clientY,
      active: false, toggleOff: wasSelected, hoverEl: null,
    };
  } else {
    const pre = Game.preSel[boardId];
    const wasSelected = !!(pre && pre.kind === 'pre-drop' && pre.type === type);
    Game.preSel[boardId] = { kind: 'pre-drop', type, color };
    render();
    dragState = {
      mode: 'predrop', boardId, color, type,
      startX: ev.clientX, startY: ev.clientY,
      active: false, toggleOff: wasSelected, hoverEl: null,
    };
  }
}

function onPointerMove(ev) {
  const d = dragState;
  if (!d) return;
  if (!d.active) {
    if (Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 6) return;
    d.active = true;
    createFloat(d);
    if (d.mode === 'move' || d.mode === 'premove') {
      const p = squareEl(d.boardId, d.r, d.f).querySelector('.piece');
      p.classList.add('drag-origin');
    }
  }
  moveFloat(ev.clientX, ev.clientY);
  updateDragHover(d, ev.clientX, ev.clientY);
}

function dragTargetLegal(d, r, f) {
  const board = Game.boards[d.boardId];
  const piece = board.get(r, f);
  if (d.mode === 'move') {
    const sel = Game.selected[d.boardId];
    return !!(sel && sel.kind === 'square' && sel.moves.some(m => m.toR === r && m.toF === f));
  }
  if (d.mode === 'drop') {
    const sel = Game.selected[d.boardId];
    return !!(sel && sel.kind === 'drop' && sel.squares.some(s => s.r === r && s.f === f));
  }
  if (d.mode === 'premove') {
    return d.targets.some(t => t.r === r && t.f === f) && !(piece && piece.color === d.color);
  }
  if (d.mode === 'predrop') {
    if (piece && piece.color === d.color) return false;
    return d.type !== 'p' || ChessBoard.pawnDropAllowed(d.color, r);
  }
  return false;
}

function onPointerUp(ev) {
  const d = dragState;
  if (!d) return;
  dragState = null;

  if (!d.active) {
    if (d.toggleOff) {
      if (d.mode === 'move' || d.mode === 'drop') Game.selected[d.boardId] = null;
      else Game.preSel[d.boardId] = null;
      render();
    }
    return;
  }

  removeFloat();
  if (d.hoverEl) d.hoverEl.classList.remove('drag-over');
  clearGhost();
  if (d.mode === 'move' || d.mode === 'premove') {
    const sq = squareEl(d.boardId, d.r, d.f);
    const p = sq && sq.querySelector('.piece');
    if (p) p.classList.remove('drag-origin');
  }

  const sqEl = boardSquareFromPoint(d.boardId, ev.clientX, ev.clientY);
  if (sqEl) {
    const r = +sqEl.dataset.r, f = +sqEl.dataset.f;
    if (dragTargetLegal(d, r, f)) {
      if (d.mode === 'move') {
        const sel = Game.selected[d.boardId];
        const move = sel.moves.find(m => m.toR === r && m.toF === f);
        if (move.promo) openPromoDialog(d.boardId, move);
        else requestMove(d.boardId, move);
        return;
      }
      if (d.mode === 'drop') {
        const sel = Game.selected[d.boardId];
        requestDrop(d.boardId, sel.color, sel.type, r, f);
        return;
      }
      if (d.mode === 'premove') {
        queuePremove(d.boardId, { kind: 'move', color: d.color, fromR: d.r, fromF: d.f, toR: r, toF: f });
        return;
      }
      if (d.mode === 'predrop') {
        queuePremove(d.boardId, { kind: 'drop', color: d.color, type: d.type, r, f });
        return;
      }
    }
  }
  render(); // no legal target: snap back, keep selection
}

function onPointerCancel() {
  const d = dragState;
  if (!d) return;
  dragState = null;
  if (!d.active) return;
  removeFloat();
  if (d.hoverEl) d.hoverEl.classList.remove('drag-over');
  clearGhost();
  render();
}

function boardSquareFromPoint(boardId, x, y) {
  const elAt = document.elementFromPoint(x, y);
  return elAt && elAt.closest ? elAt.closest(`#board-${boardId} .square`) : null;
}

function updateDragHover(d, x, y) {
  const sqEl = boardSquareFromPoint(d.boardId, x, y);
  let legal = false, r = null, f = null;
  if (sqEl) {
    r = +sqEl.dataset.r;
    f = +sqEl.dataset.f;
    legal = dragTargetLegal(d, r, f);
  }

  if (d.hoverEl && d.hoverEl !== sqEl) d.hoverEl.classList.remove('drag-over');

  if (d.mode === 'drop' || d.mode === 'predrop') {
    const board = Game.boards[d.boardId];
    const showGhost = sqEl && legal && !board.get(r, f);
    const ghostMatches = ghostRef && showGhost
      && ghostRef.boardId === d.boardId && ghostRef.r === r && ghostRef.f === f;
    if (!ghostMatches) {
      clearGhost();
      if (showGhost) setGhost(d.boardId, r, f, d.color, d.type);
    }
  }

  if (sqEl && legal) {
    sqEl.classList.add('drag-over');
    d.hoverEl = sqEl;
  } else {
    d.hoverEl = null;
  }
}

/* Floating piece that follows the cursor during a drag */
let floatEl = null;
function createFloat(d) {
  removeFloat();
  const size = squareEl(d.boardId, 0, 0).getBoundingClientRect().width * 0.95;
  floatEl = el('div', `pimg ${pieceClasses(d.color, d.type)}`, document.body);
  floatEl.id = 'drag-float';
  floatEl.style.width = `${size}px`;
  floatEl.style.height = `${size}px`;
}
function moveFloat(x, y) {
  if (!floatEl) return;
  const half = parseFloat(floatEl.style.width) / 2;
  floatEl.style.left = `${x - half}px`;
  floatEl.style.top = `${y - half}px`;
}
function removeFloat() {
  if (floatEl) { floatEl.remove(); floatEl = null; }
}

/* Ghost preview of a reserve drop on a hovered legal square */
function setGhost(boardId, r, f, color, type) {
  const p = squareEl(boardId, r, f).querySelector('.piece');
  p.className = `piece pimg ghost ${pieceClasses(color, type)}`;
  ghostRef = { boardId, r, f };
}
function clearGhost() {
  if (!ghostRef) return;
  const { boardId } = ghostRef;
  ghostRef = null;
  renderBoard(boardId);
}

function onSquareHover(boardId, r, f) {
  if (dragState && dragState.active) return;
  if (Game.over || Game.pendingPromo || !Game.boards) return;
  const board = Game.boards[boardId];
  if (board.get(r, f)) return;
  const sel = Game.selected[boardId];
  const pre = Game.preSel[boardId];
  if (sel && sel.kind === 'drop' && sel.squares.some(s => s.r === r && s.f === f)) {
    setGhost(boardId, r, f, sel.color, sel.type);
  } else if (pre && pre.kind === 'pre-drop'
    && (pre.type !== 'p' || ChessBoard.pawnDropAllowed(pre.color, r))) {
    setGhost(boardId, r, f, pre.color, pre.type);
  }
}

function onSquareLeave(boardId, r, f) {
  if (dragState && dragState.active) return;
  if (ghostRef && ghostRef.boardId === boardId && ghostRef.r === r && ghostRef.f === f) {
    clearGhost();
  }
}

/* ---------------- Piece requests ---------------- */

function sendRequest(boardId, color, type) {
  if (Game.over) return;
  if (!canAct(boardId, color)) return;
  if (Net.mode === 'online') {
    netSend({ t: 'request', type });
    return; // server relays back to everyone, including us
  }
  const mateBoard = otherBoard(boardId);
  const mateColor = opposite(color);
  const until = Date.now() + 8000;
  Game.requests[mateBoard] = { type, color, until };
  Game.badges[`${mateBoard}-${mateColor}`] = { type, color, until };
  soundRequest();
  render();
  setTimeout(render, 8200);
}

/* ---------------- Rendering ---------------- */

function render() {
  if (!Game.boards) return;
  for (const id of BOARD_IDS) renderBoard(id);
  renderPanels();
  renderClocks();
}

function renderBoard(id) {
  const board = Game.boards[id];
  const sel = Game.selected[id];
  const pre = Game.preSel[id];
  const pm = Game.premove[id];
  const req = Game.requests[id];
  const reqActive = req && Date.now() < req.until;
  const last = board.lastMove;
  const checks = {};
  for (const c of COLORS) {
    if (board.inCheck(c)) {
      const grid = board.board;
      for (let r = 0; r < 8; r++) for (let f = 0; f < 8; f++) {
        const p = grid[r][f];
        if (p && p.type === 'k' && p.color === c) checks[`${r},${f}`] = true;
      }
    }
  }

  const squares = $(`#board-${id}`).children;
  for (const sq of squares) {
    const r = +sq.dataset.r, f = +sq.dataset.f;
    const piece = board.get(r, f);
    const pieceEl = sq.querySelector('.piece');
    const queuedDropHere = pm && pm.kind === 'drop' && pm.r === r && pm.f === f && !piece;
    pieceEl.className = piece ? `piece pimg ${pieceClasses(piece.color, piece.type)}`
      : queuedDropHere ? `piece pimg ghost ${pieceClasses(pm.color, pm.type)}`
      : 'piece pimg';

    sq.classList.toggle('sel', !!(sel && sel.kind === 'square' && sel.r === r && sel.f === f));
    const move = sel && sel.kind === 'square' ? sel.moves.find(m => m.toR === r && m.toF === f) : null;
    sq.classList.toggle('target', !!(move && !piece && !move.ep));
    sq.classList.toggle('capture-target', !!(move && (piece || move.ep)));
    sq.classList.toggle('drop-target', !!(sel && sel.kind === 'drop' && sel.squares.some(s => s.r === r && s.f === f)));
    sq.classList.toggle('pre-sel', !!(pre && pre.kind === 'pre-square' && pre.r === r && pre.f === f));
    sq.classList.toggle('pre-target',
      !!(pre && pre.kind === 'pre-square' && pre.targets.some(t => t.r === r && t.f === f)
        && !(piece && piece.color === pre.color)));
    sq.classList.toggle('premove-from', !!(pm && pm.kind === 'move' && pm.fromR === r && pm.fromF === f));
    sq.classList.toggle('premove-to',
      !!(pm && ((pm.kind === 'move' && pm.toR === r && pm.toF === f)
        || (pm.kind === 'drop' && pm.r === r && pm.f === f))));
    sq.classList.toggle('last-from', !!(last && last.from && last.from.r === r && last.from.f === f));
    sq.classList.toggle('last-to', !!(last && last.to.r === r && last.to.f === f));
    sq.classList.toggle('check', !!checks[`${r},${f}`]);
    sq.classList.toggle('requested',
      !!(reqActive && piece && piece.type === req.type && piece.color === req.color));
  }
}

function renderPanels() {
  for (const id of BOARD_IDS) {
    const board = Game.boards[id];
    for (const c of COLORS) {
      const panel = $(`#panel-${id}-${c}`);
      panel.classList.toggle('foreign', Net.mode === 'online' && Net.seat !== `${id}-${c}`);

      const nameEl = $(`#pname-${id}-${c}`);
      const offline = Game.connected && Game.connected[`${id}-${c}`] === false;
      nameEl.textContent = playerName(id, c) + (offline ? ' ⚠ offline' : '');

      const sel = Game.selected[id];
      const pre = Game.preSel[id];
      const chips = $(`#reserve-${id}-${c}`).children;
      for (const chip of chips) {
        const type = chip.dataset.type;
        const count = board.reserves[c][type];
        chip.querySelector('.cnt').textContent = count;
        chip.classList.toggle('empty', count === 0);
        chip.classList.toggle('usable', count > 0 && !Game.over && canAct(id, c));
        chip.classList.toggle('sel',
          !!(sel && sel.kind === 'drop' && sel.color === c && sel.type === type)
          || !!(pre && pre.kind === 'pre-drop' && pre.color === c && pre.type === type));
      }

      const badgeEl = $(`#badge-${id}-${c}`);
      const badge = Game.badges[`${id}-${c}`];
      if (badge && Date.now() < badge.until) {
        badgeEl.classList.add('show');
        badgeEl.innerHTML = '';
        badgeEl.appendChild(document.createTextNode('Teammate needs'));
        pieceImg(badge.color, badge.type, 'badge-piece', badgeEl);
      } else {
        badgeEl.classList.remove('show');
      }
    }
  }
}

/* ---------------- Game end ---------------- */

function endGameLocal(winnerTeam, reason) {
  if (Game.over) return;
  Game.over = { winner: winnerTeam, reason };
  Game.premove = { A: null, B: null };
  Game.preSel = { A: null, B: null };
  stopClock();
  presentGameOver(winnerTeam, reason);
  render();
}

function presentGameOver(winnerTeam, reason) {
  soundEnd();
  const title = $('#go-title');
  if (winnerTeam === 0) {
    title.textContent = 'Draw';
  } else {
    const members = winnerTeam === 1
      ? `${playerName('A', 'w')} & ${playerName('B', 'b')}`
      : `${playerName('A', 'b')} & ${playerName('B', 'w')}`;
    title.textContent = `Team ${winnerTeam} wins! (${members})`;
  }
  $('#go-reason').textContent = reason;
  $('#gameover').classList.remove('hidden');
}

/* ---------------- Boot ---------------- */

initSetup();
