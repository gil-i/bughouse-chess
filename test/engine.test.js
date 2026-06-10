'use strict';
const assert = require('assert');
const { ChessBoard } = require('../engine.js');

function mv(b, from, to, extra = {}) {
  const fromF = from.charCodeAt(0) - 97, fromR = +from[1] - 1;
  const toF = to.charCodeAt(0) - 97, toR = +to[1] - 1;
  const legal = b.legalMovesFrom(fromR, fromF);
  const m = legal.find(x => x.toR === toR && x.toF === toF);
  assert(m, `move ${from}-${to} should be legal`);
  return b.makeMove({ ...m, ...extra });
}

// 1. Initial position has 20 legal moves
let b = new ChessBoard();
assert.strictEqual(b.allLegalMoves('w').length, 20, '20 opening moves');

// 2. Capture reporting: 1.e4 d5 2.exd5 captures a black pawn
b = new ChessBoard();
mv(b, 'e2', 'e4'); mv(b, 'd7', 'd5');
const res = mv(b, 'e4', 'd5');
assert.deepStrictEqual(res.captured, { type: 'p', color: 'b' }, 'captured black pawn');

// 3. Drop rules: a knight drop on f6 in the opening would give check -> illegal
b = new ChessBoard();
mv(b, 'e2', 'e4'); mv(b, 'e7', 'e5');
b.reserves.w.n = 1;
const nDrops = b.legalDropSquares('w', 'n').map(s => `${s.r},${s.f}`);
assert(!nDrops.includes('5,5'), 'Nf6 drop would check ke8 -> forbidden');
assert(!nDrops.includes('5,3'), 'Nd6 drop would check ke8 -> forbidden');
assert(nDrops.includes('2,2'), 'Nc3 drop is fine');

// 4. Pawn drop rank limits: white forbidden on ranks 1, 7, 8
b = new ChessBoard();
mv(b, 'e2', 'e4'); mv(b, 'e7', 'e5');
b.reserves.w.p = 1;
const pDrops = b.legalDropSquares('w', 'p');
assert(pDrops.every(s => s.r >= 1 && s.r <= 5), 'white pawn drops only on ranks 2-6');
b.reserves.b.p = 1;
b.turn = 'b';
const bp = b.legalDropSquares('b', 'p');
assert(bp.every(s => s.r >= 2 && s.r <= 6), 'black pawn drops only on ranks 3-7');

// 5. Fool's mate is NOT mate in bughouse (a future drop on f2/g3 could block)
b = new ChessBoard();
mv(b, 'f2', 'f3'); mv(b, 'e7', 'e5');
mv(b, 'g2', 'g4'); mv(b, 'd8', 'h4');
assert(b.inCheck('w'), 'white is in check');
assert.strictEqual(b.allLegalMoves('w').length, 0, 'no normal escape');
assert.strictEqual(b.status(), 'playing', 'not mate: can wait for a blocker');

// 5b. ...but with a pawn in reserve, white can actually block now
b.reserves.w.p = 1;
const blocks = b.legalDropSquares('w', 'p').map(s => `${s.r},${s.f}`);
assert(blocks.includes('1,5') || blocks.includes('2,6'), 'pawn can interpose at f2/g3');

// 6. Contact check with no escape IS mate (drops cannot interpose)
b = new ChessBoard();
b.board = Array.from({ length: 8 }, () => Array(8).fill(null));
b.board[0][7] = { type: 'k', color: 'w', promoted: false }; // Kh1
b.board[7][4] = { type: 'k', color: 'b', promoted: false }; // ke8
b.board[1][6] = { type: 'q', color: 'b', promoted: false }; // qg2 (contact check)
b.board[2][5] = { type: 'p', color: 'b', promoted: false }; // pf3 guards g2
b.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
b.turn = 'w';
b.reserves.w.q = 5; // even a full reserve cannot help
assert.strictEqual(b.status(), 'checkmate', 'smothered-style contact mate');

// 7. Castling works and is blocked through check
b = new ChessBoard();
mv(b, 'e2', 'e4'); mv(b, 'e7', 'e5');
mv(b, 'g1', 'f3'); mv(b, 'b8', 'c6');
mv(b, 'f1', 'c4'); mv(b, 'g8', 'f6');
const kingMoves = b.legalMovesFrom(0, 4);
assert(kingMoves.some(m => m.castle === 'k'), 'white can castle kingside');
mv(b, 'e1', 'g1');
assert(b.board[0][6].type === 'k' && b.board[0][5].type === 'r', 'castled: Kg1 Rf1');

// 8. En passant
b = new ChessBoard();
mv(b, 'e2', 'e4'); mv(b, 'a7', 'a6');
mv(b, 'e4', 'e5'); mv(b, 'd7', 'd5');
const epRes = mv(b, 'e5', 'd6');
assert.deepStrictEqual(epRes.captured, { type: 'p', color: 'b' }, 'ep captures the pawn');
assert.strictEqual(b.board[4][3], null, 'd5 pawn removed by ep');

// 9. Promotion + promoted piece reverts to pawn when captured
b = new ChessBoard();
b.board = Array.from({ length: 8 }, () => Array(8).fill(null));
b.board[0][4] = { type: 'k', color: 'w', promoted: false };
b.board[6][2] = { type: 'k', color: 'b', promoted: false }; // kc7 (adjacent to b8)
b.board[6][0] = { type: 'p', color: 'w', promoted: false }; // Pa7
b.board[7][1] = { type: 'r', color: 'b', promoted: false }; // rb8
b.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
b.turn = 'w';
const promo = b.legalMovesFrom(6, 0).find(m => m.toF === 1 && m.promo);
assert(promo, 'axb8=Q available');
b.makeMove({ ...promo, promoType: 'q' });
assert(b.board[7][1].type === 'q' && b.board[7][1].promoted, 'promoted queen on b8');
const capMove = b.legalMovesFrom(6, 2).find(m => m.toR === 7 && m.toF === 1);
assert(capMove, 'kxb8 available (queen is unguarded)');
const cap = b.makeMove(capMove);
assert.deepStrictEqual(cap.captured, { type: 'p', color: 'w' }, 'promoted q reverts to pawn');

// 10. Drop resolves check by interposition
b = new ChessBoard();
b.board = Array.from({ length: 8 }, () => Array(8).fill(null));
b.board[0][4] = { type: 'k', color: 'w', promoted: false }; // Ke1
b.board[7][4] = { type: 'k', color: 'b', promoted: false }; // ke8
b.board[5][4] = { type: 'r', color: 'b', promoted: false }; // re6 checking down e-file
b.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
b.turn = 'w';
b.reserves.w.n = 1;
assert(b.inCheck('w'));
const dSquares = b.legalDropSquares('w', 'n').map(s => `${s.r},${s.f}`);
assert(dSquares.length > 0 && dSquares.every(s => s.split(',')[1] === '4'), 'only e-file interpositions');
b.makeDrop('w', 'n', 3, 4); // N@e4 blocks
assert(!b.inCheck('w'), 'check blocked by drop');
assert.strictEqual(b.reserves.w.n, 0, 'reserve consumed');

// 11. promoProvider gates promotion moves
b = new ChessBoard();
b.board = Array.from({ length: 8 }, () => Array(8).fill(null));
b.board[0][4] = { type: 'k', color: 'w', promoted: false };
b.board[5][7] = { type: 'k', color: 'b', promoted: false }; // kh6, far away
b.board[6][0] = { type: 'p', color: 'w', promoted: false }; // Pa7
b.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
b.turn = 'w';
b.promoProvider = () => [];
assert.strictEqual(b.legalMovesFrom(6, 0).length, 0, 'no promotion possible -> pawn stuck');
b.promoProvider = () => ['n'];
assert(b.legalMovesFrom(6, 0).some(m => m.promo), 'promotion allowed when a piece is available');
b.promoProvider = null;
assert(b.legalMovesFrom(6, 0).some(m => m.promo), 'null provider = unrestricted');

console.log('All engine tests passed.');
