'use strict';

/* ============================================================
 * engine.js — single-board chess engine with bughouse drops.
 *
 * Board coordinates: r = rank index 0..7 (0 = rank 1, white's
 * back rank), f = file index 0..7 (0 = file a).
 *
 * Custom drop rules enforced here:
 *   - A drop may never give check to the opponent.
 *   - A pawn may not be dropped on the dropper's relative
 *     7th/8th ranks, nor on their own back rank.
 * ============================================================ */

const FILES = 'abcdefgh';

const KNIGHT_OFFSETS = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING_OFFSETS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];

const DROP_TYPES = ['p', 'n', 'b', 'r', 'q'];

function opposite(c) { return c === 'w' ? 'b' : 'w'; }
function onBoard(r, f) { return r >= 0 && r < 8 && f >= 0 && f < 8; }
function sqName(r, f) { return FILES[f] + (r + 1); }

function emptyGrid() {
  return Array.from({ length: 8 }, () => Array(8).fill(null));
}

/* Is square (r,f) attacked by color `by` on grid? */
function attacked(grid, r, f, by) {
  // Knights
  for (const [dr, df] of KNIGHT_OFFSETS) {
    const rr = r + dr, ff = f + df;
    if (onBoard(rr, ff)) {
      const p = grid[rr][ff];
      if (p && p.color === by && p.type === 'n') return true;
    }
  }
  // King
  for (const [dr, df] of KING_OFFSETS) {
    const rr = r + dr, ff = f + df;
    if (onBoard(rr, ff)) {
      const p = grid[rr][ff];
      if (p && p.color === by && p.type === 'k') return true;
    }
  }
  // Pawns: a white pawn on (r-1, f±1) attacks (r,f); black from (r+1, f±1)
  const pr = by === 'w' ? r - 1 : r + 1;
  for (const ff of [f - 1, f + 1]) {
    if (onBoard(pr, ff)) {
      const p = grid[pr][ff];
      if (p && p.color === by && p.type === 'p') return true;
    }
  }
  // Sliders
  for (const [dirs, types] of [[ROOK_DIRS, ['r', 'q']], [BISHOP_DIRS, ['b', 'q']]]) {
    for (const [dr, df] of dirs) {
      let rr = r + dr, ff = f + df;
      while (onBoard(rr, ff)) {
        const p = grid[rr][ff];
        if (p) {
          if (p.color === by && types.includes(p.type)) return true;
          break;
        }
        rr += dr; ff += df;
      }
    }
  }
  return false;
}

function findKingOn(grid, color) {
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = grid[r][f];
      if (p && p.type === 'k' && p.color === color) return { r, f };
    }
  }
  return null;
}

function inCheckOn(grid, color) {
  const k = findKingOn(grid, color);
  return k ? attacked(grid, k.r, k.f, opposite(color)) : false;
}

class ChessBoard {
  constructor() {
    const back = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];
    this.board = emptyGrid();
    for (let f = 0; f < 8; f++) {
      this.board[0][f] = { type: back[f], color: 'w', promoted: false };
      this.board[1][f] = { type: 'p', color: 'w', promoted: false };
      this.board[6][f] = { type: 'p', color: 'b', promoted: false };
      this.board[7][f] = { type: back[f], color: 'b', promoted: false };
    }
    this.turn = 'w';
    this.castling = { w: { k: true, q: true }, b: { k: true, q: true } };
    this.ep = null; // square skipped by the last double pawn push, e.g. {r, f}
    this.reserves = {
      w: { p: 0, n: 0, b: 0, r: 0, q: 0 },
      b: { p: 0, n: 0, b: 0, r: 0, q: 0 },
    };
    this.lastMove = null;
    // Optional hook: (color) => piece types this color may promote to.
    // null = unrestricted (plain chess). The bughouse app wires this to
    // "pieces that can be taken from the other board".
    this.promoProvider = null;
  }

  promoTypesAvailable(color) {
    if (!this.promoProvider) return ['q', 'r', 'b', 'n'];
    return this.promoProvider(color);
  }

  get(r, f) { return this.board[r][f]; }

  inCheck(color) { return inCheckOn(this.board, color); }

  cloneGrid() { return this.board.map(row => row.slice()); }

  /* Apply a move's mechanics onto a grid (used both for legality
   * simulation and for the real move). Returns the captured piece. */
  static applyToGrid(grid, move) {
    const piece = grid[move.fromR][move.fromF];
    let captured = grid[move.toR][move.toF];
    grid[move.fromR][move.fromF] = null;
    if (move.ep) {
      captured = grid[move.fromR][move.toF];
      grid[move.fromR][move.toF] = null;
    }
    if (move.promo) {
      grid[move.toR][move.toF] = { type: move.promoType || 'q', color: piece.color, promoted: true };
    } else {
      grid[move.toR][move.toF] = piece;
    }
    if (move.castle) {
      const row = move.fromR;
      if (move.castle === 'k') {
        grid[row][5] = grid[row][7];
        grid[row][7] = null;
      } else {
        grid[row][3] = grid[row][0];
        grid[row][0] = null;
      }
    }
    return captured;
  }

  isMoveLegal(move) {
    const grid = this.cloneGrid();
    const color = grid[move.fromR][move.fromF].color;
    ChessBoard.applyToGrid(grid, move);
    return !inCheckOn(grid, color);
  }

  pseudoMovesFrom(r, f) {
    const piece = this.board[r][f];
    if (!piece) return [];
    const moves = [];
    const add = (toR, toF, extra) => moves.push({ fromR: r, fromF: f, toR, toF, ...extra });
    const enemy = opposite(piece.color);

    if (piece.type === 'p') {
      const dir = piece.color === 'w' ? 1 : -1;
      const startRank = piece.color === 'w' ? 1 : 6;
      const lastRank = piece.color === 'w' ? 7 : 0;
      const one = r + dir;
      if (onBoard(one, f) && !this.board[one][f]) {
        add(one, f, { promo: one === lastRank });
        const two = r + 2 * dir;
        if (r === startRank && !this.board[two][f]) add(two, f, { double: true });
      }
      for (const ff of [f - 1, f + 1]) {
        if (!onBoard(one, ff)) continue;
        const target = this.board[one][ff];
        if (target && target.color === enemy) add(one, ff, { promo: one === lastRank });
        else if (!target && this.ep && this.ep.r === one && this.ep.f === ff) add(one, ff, { ep: true });
      }
    } else if (piece.type === 'n' || piece.type === 'k') {
      const offsets = piece.type === 'n' ? KNIGHT_OFFSETS : KING_OFFSETS;
      for (const [dr, df] of offsets) {
        const rr = r + dr, ff = f + df;
        if (!onBoard(rr, ff)) continue;
        const target = this.board[rr][ff];
        if (!target || target.color === enemy) add(rr, ff, {});
      }
      if (piece.type === 'k') this.addCastlingMoves(piece.color, moves);
    } else {
      const dirs = piece.type === 'r' ? ROOK_DIRS
        : piece.type === 'b' ? BISHOP_DIRS
        : [...ROOK_DIRS, ...BISHOP_DIRS];
      for (const [dr, df] of dirs) {
        let rr = r + dr, ff = f + df;
        while (onBoard(rr, ff)) {
          const target = this.board[rr][ff];
          if (!target) add(rr, ff, {});
          else {
            if (target.color === enemy) add(rr, ff, {});
            break;
          }
          rr += dr; ff += df;
        }
      }
    }
    return moves;
  }

  addCastlingMoves(color, moves) {
    const row = color === 'w' ? 0 : 7;
    const rights = this.castling[color];
    const enemy = opposite(color);
    const king = this.board[row][4];
    if (!king || king.type !== 'k' || king.color !== color) return;
    if (attacked(this.board, row, 4, enemy)) return;
    if (rights.k
      && !this.board[row][5] && !this.board[row][6]
      && this.board[row][7] && this.board[row][7].type === 'r' && this.board[row][7].color === color
      && !attacked(this.board, row, 5, enemy) && !attacked(this.board, row, 6, enemy)) {
      moves.push({ fromR: row, fromF: 4, toR: row, toF: 6, castle: 'k' });
    }
    if (rights.q
      && !this.board[row][3] && !this.board[row][2] && !this.board[row][1]
      && this.board[row][0] && this.board[row][0].type === 'r' && this.board[row][0].color === color
      && !attacked(this.board, row, 3, enemy) && !attacked(this.board, row, 2, enemy)) {
      moves.push({ fromR: row, fromF: 4, toR: row, toF: 2, castle: 'q' });
    }
  }

  _legalMovesAt(r, f) {
    const piece = this.board[r][f];
    if (!piece) return [];
    let moves = this.pseudoMovesFrom(r, f);
    if (piece.type === 'p' && moves.some(m => m.promo)
      && this.promoTypesAvailable(piece.color).length === 0) {
      moves = moves.filter(m => !m.promo); // nothing available to promote to
    }
    return moves.filter(m => this.isMoveLegal(m));
  }

  legalMovesFrom(r, f) {
    const piece = this.board[r][f];
    if (!piece || piece.color !== this.turn) return [];
    return this._legalMovesAt(r, f);
  }

  allLegalMoves(color) {
    const out = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        const p = this.board[r][f];
        if (p && p.color === color) out.push(...this._legalMovesAt(r, f));
      }
    }
    return out;
  }

  /* Pawn drop rank restriction (relative to the dropping side):
   * forbidden on relative ranks 7 and 8 (custom rule) and on the
   * dropper's own back rank (a pawn can never stand there). */
  static pawnDropAllowed(color, r) {
    if (color === 'w') return r >= 1 && r <= 5;
    return r >= 2 && r <= 6;
  }

  /* Would dropping `type` of `color` on (r,f) be legal?
   * Square must be empty; pawn rank rules; the drop must not leave
   * the dropper in check and must NOT give check to the opponent. */
  isDropLegal(color, type, r, f) {
    if (this.board[r][f]) return false;
    if (type === 'p' && !ChessBoard.pawnDropAllowed(color, r)) return false;
    const grid = this.cloneGrid();
    grid[r][f] = { type, color, promoted: false };
    if (inCheckOn(grid, color)) return false;
    if (inCheckOn(grid, opposite(color))) return false; // custom: no drop-checks
    return true;
  }

  legalDropSquares(color, type) {
    const out = [];
    for (let r = 0; r < 8; r++) {
      for (let f = 0; f < 8; f++) {
        if (this.isDropLegal(color, type, r, f)) out.push({ r, f });
      }
    }
    return out;
  }

  hasAnyLegalDrop(color) {
    for (const type of DROP_TYPES) {
      if (this.reserves[color][type] > 0 && this.legalDropSquares(color, type).length > 0) return true;
    }
    return false;
  }

  /* Could a drop of ANY hypothetical piece (whether or not it is in
   * the reserve right now) resolve the current situation? Used for
   * mate detection: in bughouse you may sit and wait for material. */
  couldAnyHypotheticalDropHelp(color) {
    for (const type of DROP_TYPES) {
      for (let r = 0; r < 8; r++) {
        for (let f = 0; f < 8; f++) {
          if (this.isDropLegal(color, type, r, f)) return true;
        }
      }
    }
    return false;
  }

  /* Status for the side to move:
   *  'checkmate'  — in check, no move, and no drop (not even a
   *                 hypothetical future one) could resolve it
   *  'stalemate'  — not in check but no action will ever be possible
   *  'playing'    — otherwise (includes "waiting for material")     */
  status() {
    const color = this.turn;
    if (this.allLegalMoves(color).length > 0) return 'playing';
    if (this.hasAnyLegalDrop(color)) return 'playing';
    if (this.couldAnyHypotheticalDropHelp(color)) return 'playing'; // sit & wait
    return this.inCheck(color) ? 'checkmate' : 'stalemate';
  }

  /* Execute a legal move. Returns {captured} where captured is
   * {type, color} from the recipient team's perspective (promoted
   * pieces revert to pawns), or null. */
  makeMove(move) {
    const piece = this.board[move.fromR][move.fromF];
    const capturedPiece = ChessBoard.applyToGrid(this.board, move);

    // Castling rights
    const rights = this.castling;
    if (piece.type === 'k') { rights[piece.color].k = false; rights[piece.color].q = false; }
    if (piece.type === 'r') {
      if (move.fromR === 0 && move.fromF === 0) rights.w.q = false;
      if (move.fromR === 0 && move.fromF === 7) rights.w.k = false;
      if (move.fromR === 7 && move.fromF === 0) rights.b.q = false;
      if (move.fromR === 7 && move.fromF === 7) rights.b.k = false;
    }
    if (capturedPiece && capturedPiece.type === 'r') {
      if (move.toR === 0 && move.toF === 0) rights.w.q = false;
      if (move.toR === 0 && move.toF === 7) rights.w.k = false;
      if (move.toR === 7 && move.toF === 0) rights.b.q = false;
      if (move.toR === 7 && move.toF === 7) rights.b.k = false;
    }

    this.ep = move.double ? { r: (move.fromR + move.toR) / 2, f: move.fromF } : null;
    this.lastMove = {
      from: { r: move.fromR, f: move.fromF },
      to: { r: move.toR, f: move.toF },
      drop: false,
    };
    this.turn = opposite(this.turn);

    if (!capturedPiece) return { captured: null };
    return {
      captured: {
        type: capturedPiece.promoted ? 'p' : capturedPiece.type,
        color: capturedPiece.color,
      },
    };
  }

  makeDrop(color, type, r, f) {
    if (this.reserves[color][type] <= 0) throw new Error('no such piece in reserve');
    if (!this.isDropLegal(color, type, r, f)) throw new Error('illegal drop');
    this.reserves[color][type]--;
    this.board[r][f] = { type, color, promoted: false };
    this.ep = null;
    this.lastMove = { from: null, to: { r, f }, drop: true, type };
    this.turn = opposite(this.turn);
  }
}

/* ---- Promotion-by-removal helpers (shared by client and server) ----
 * Under the house promotion rule, a pawn promotes by removing a piece
 * of its own color from the OTHER board. These helpers operate on that
 * other board. */

/* Pieces of `color` on `board` that may be taken for a promotion:
 * knights/bishops/rooks/queens whose removal leaves no king illegally
 * in check here (i.e. not pinned). */
function removableForPromotion(board, color) {
  const out = [];
  for (let r = 0; r < 8; r++) {
    for (let f = 0; f < 8; f++) {
      const p = board.board[r][f];
      if (!p || p.color !== color || !['q', 'r', 'b', 'n'].includes(p.type)) continue;
      const grid = board.cloneGrid();
      grid[r][f] = null;
      // pinned: removal would expose its own king
      if (inCheckOn(grid, color)) continue;
      // never leave the side that is NOT to move in check
      const enemy = opposite(color);
      if (board.turn !== enemy && inCheckOn(grid, enemy)) continue;
      out.push({ r, f, type: p.type });
    }
  }
  return out;
}

function removePromotionPiece(board, cand) {
  const p = board.board[cand.r][cand.f];
  board.board[cand.r][cand.f] = null;
  // a removed rook loses its castling rights
  if (p && p.type === 'r') {
    if (cand.r === 0 && cand.f === 0) board.castling.w.q = false;
    if (cand.r === 0 && cand.f === 7) board.castling.w.k = false;
    if (cand.r === 7 && cand.f === 0) board.castling.b.q = false;
    if (cand.r === 7 && cand.f === 7) board.castling.b.k = false;
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    ChessBoard, opposite, sqName, attacked, inCheckOn, DROP_TYPES,
    removableForPromotion, removePromotionPiece,
  };
}
