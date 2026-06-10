'use strict';
/* End-to-end UI test: drives the real app in headless Chrome. */
const path = require('path');
const assert = require('assert');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

async function clickSquare(page, boardId, alg) {
  const f = alg.charCodeAt(0) - 97;
  const r = +alg[1] - 1;
  await page.click(`#board-${boardId} .square[data-r="${r}"][data-f="${f}"]`);
}

async function move(page, boardId, from, to) {
  await clickSquare(page, boardId, from);
  await clickSquare(page, boardId, to);
}

async function squareCenter(page, boardId, alg) {
  const f = alg.charCodeAt(0) - 97;
  const r = +alg[1] - 1;
  const h = await page.$(`#board-${boardId} .square[data-r="${r}"][data-f="${f}"]`);
  const box = await h.boundingBox();
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

(async () => {
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1500, height: 1000 });
  page.on('pageerror', e => { console.error('PAGE ERROR:', e.message); process.exitCode = 1; });
  await page.goto('file://' + path.resolve(__dirname, '..', 'index.html'));

  // --- Setup screen: names, preset, start ---
  await page.type('#name-A-w', 'Alice');
  await page.type('#name-B-b', 'Bob');
  await page.type('#name-A-b', 'Carol');
  await page.type('#name-B-w', 'Dave');
  await page.evaluate(() => {
    [...document.querySelectorAll('#tc-presets button')]
      .find(b => b.textContent === '5+5').click();
  });
  await page.screenshot({ path: 'test/shots/01-setup.png' });
  await page.click('#start-btn');
  await page.waitForSelector('#game:not(.hidden)');

  // Names rendered
  const matchup = await page.$eval('#matchup', e => e.textContent);
  assert(matchup.includes('Alice') && matchup.includes('Dave'), 'matchup line shows names');

  // --- Board A: 1.e4 played via DRAG-AND-DROP ---
  const e2 = await squareCenter(page, 'A', 'e2');
  const e4 = await squareCenter(page, 'A', 'e4');
  await page.mouse.move(e2.x, e2.y);
  await page.mouse.down();
  await page.mouse.move(e4.x, e4.y, { steps: 8 });
  assert(await page.$('#drag-float'), 'floating piece follows cursor during drag');
  const originFaded = await page.$eval('#board-A .square[data-r="1"][data-f="4"] .piece',
    e => e.classList.contains('drag-origin'));
  assert(originFaded, 'origin piece is faded while dragging');
  const dragOver = await page.$eval('#board-A .square[data-r="3"][data-f="4"]',
    e => e.classList.contains('drag-over'));
  assert(dragOver, 'hovered legal square is highlighted during drag');
  await page.mouse.up();
  assert(!(await page.$('#drag-float')), 'floating piece removed after drop');
  const e4piece = await page.$eval('#board-A .square[data-r="3"][data-f="4"] .piece', e => [...e.classList]);
  assert(e4piece.includes('p') && e4piece.includes('w'), 'pawn landed on e4 via drag');

  // ...then 1...d5 2.exd5 by click-click (capture feeds Bob's reserve on board B)
  await move(page, 'A', 'd7', 'd5');
  await move(page, 'A', 'e4', 'd5');

  let bobPawns = await page.$eval('#reserve-B-b .chip[data-type="p"] .cnt', e => e.textContent);
  assert.strictEqual(bobPawns, '1', `Bob (black, board B) should have 1 pawn in reserve, got ${bobPawns}`);

  // --- Board B runs independently: 1.d4 (Dave) e5 (Bob) 2.dxe5 -> Carol gets a pawn ---
  await move(page, 'B', 'd2', 'd4');
  await move(page, 'B', 'e7', 'e5');
  await move(page, 'B', 'd4', 'e5');
  let carolPawns = await page.$eval('#reserve-A-b .chip[data-type="p"] .cnt', e => e.textContent);
  assert.strictEqual(carolPawns, '1', 'Carol (black, board A) should have 1 pawn in reserve');

  // --- Drop: it's Bob's turn on board B; he drops his reserve pawn ---
  await page.click('#reserve-B-b .chip[data-type="p"]');
  const dropTargets = await page.$$eval('#board-B .square.drop-target', els => els.length);
  assert(dropTargets > 20, `expected many legal drop squares, got ${dropTargets}`);
  // pawn must not be droppable on black's relative 7th/8th (ranks 1-2)
  const badTargets = await page.$$eval('#board-B .square.drop-target',
    els => els.filter(e => +e.dataset.r <= 1).length);
  assert.strictEqual(badTargets, 0, 'no pawn drops on black relative 7th/8th rank');
  // Hovering a legal square with a drop selected shows a GHOST piece
  const d6c = await squareCenter(page, 'B', 'd6');
  await page.mouse.move(d6c.x, d6c.y);
  const ghost = await page.$eval('#board-B .square[data-r="5"][data-f="3"] .piece', e => [...e.classList]);
  assert(ghost.includes('ghost') && ghost.includes('p') && ghost.includes('b'),
    `ghost pawn previewed on hovered drop square, got ${ghost.join(' ')}`);
  await page.screenshot({ path: 'test/shots/02-drop-targets.png' });
  // moving off the square clears the ghost
  const e3c = await squareCenter(page, 'B', 'e3'); // e3 is legal too; ghost moves there
  await page.mouse.move(e3c.x, e3c.y);
  const cleared = await page.$eval('#board-B .square[data-r="5"][data-f="3"] .piece', e => [...e.classList]);
  assert(!cleared.includes('ghost'), 'ghost cleared when leaving the square');

  await clickSquare(page, 'B', 'd6'); // drop p@d6
  bobPawns = await page.$eval('#reserve-B-b .chip[data-type="p"] .cnt', e => e.textContent);
  assert.strictEqual(bobPawns, '0', 'reserve consumed after drop');
  const d6 = await page.$eval('#board-B .square[data-r="5"][data-f="3"] .piece', e => [...e.classList]);
  assert(d6.includes('p') && d6.includes('b') && !d6.includes('ghost'), 'real pawn dropped on d6');

  // --- Request: Alice (A,w) asks her teammate Bob (B,b) for a knight ---
  await page.evaluate(() => {
    document.querySelectorAll('#panel-A-w .req-btns button')[1].click(); // knight
  });
  const badgeVisible = await page.$eval('#badge-B-b', e => e.classList.contains('show'));
  assert(badgeVisible, 'Bob sees the request badge');
  const badgePiece = await page.$eval('#badge-B-b .badge-piece', e => [...e.classList]);
  assert(badgePiece.includes('n') && badgePiece.includes('w'), 'badge shows requested piece image');
  // White knights on board B should be highlighted (Bob captures white pieces)
  const highlighted = await page.$$eval('#board-B .square.requested .piece', els => els.map(e => e.className));
  assert(highlighted.length === 2 && highlighted.every(c => c.includes('w')),
    `both white knights on board B highlighted, got ${JSON.stringify(highlighted)}`);
  await page.screenshot({ path: 'test/shots/03-request.png' });

  // --- Clocks: white clocks active where it's white's turn ---
  const clockActiveAw = await page.$eval('#clock-A-w', e => e.classList.contains('active'));
  const turnA = await page.evaluate(() => Game.boards.A.turn);
  assert.strictEqual(clockActiveAw, turnA === 'w', 'active clock matches side to move on A');

  // Clocks count down
  const t1 = await page.evaluate(() => Game.clocks.A[Game.boards.A.turn]);
  await new Promise(res => setTimeout(res, 700));
  const t2 = await page.evaluate(() => Game.clocks.A[Game.boards.A.turn]);
  assert(t2 < t1, 'clock is ticking');

  // Increment applied: Alice moved 2x with +5s inc; her clock should exceed base - elapsed
  const aliceClock = await page.evaluate(() => Game.clocks.A.w);
  assert(aliceClock > 5 * 60000, 'increment pushed Alice above base time');

  // --- Checkmate ends the whole match: smothered mate on board A ---
  // (a knight contact check cannot be blocked by a drop, so it is a
  //  real bughouse mate, unlike back-rank mates with open squares)
  await page.evaluate(() => {
    const b = Game.boards.A;
    b.board = Array.from({ length: 8 }, () => Array(8).fill(null));
    const put = (r, f, type, color) => b.board[r][f] = { type, color, promoted: false };
    put(0, 4, 'k', 'w');                           // Ke1
    put(7, 7, 'k', 'b'); put(7, 6, 'r', 'b');      // kh8, rg8
    put(6, 6, 'p', 'b'); put(6, 7, 'p', 'b');      // pg7, ph7
    put(4, 6, 'n', 'w');                           // Ng5
    b.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
    b.turn = 'w';
    render();
  });
  await move(page, 'A', 'g5', 'f7'); // Nf7# smothered
  const overState = await page.evaluate(() => Game.over);
  assert(overState && overState.winner === 1, 'Team 1 wins by checkmate on board A');
  const goTitle = await page.$eval('#go-title', e => e.textContent);
  assert(goTitle.includes('Team 1') && goTitle.includes('Alice') && goTitle.includes('Bob'), 'winner overlay names Team 1');
  await page.screenshot({ path: 'test/shots/04-gameover.png' });

  // Clocks stopped after game end
  const c1 = await page.evaluate(() => Game.clocks.B[Game.boards.B.turn]);
  await new Promise(res => setTimeout(res, 400));
  const c2 = await page.evaluate(() => Game.clocks.B[Game.boards.B.turn]);
  assert.strictEqual(c1, c2, 'clocks frozen after match end');

  // --- Rematch resets everything ---
  await page.click('#rematch-btn');
  const fresh = await page.evaluate(() =>
    Game.over === null && Game.boards.A.turn === 'w' && Game.boards.B.reserves.b.p === 0);
  assert(fresh, 'rematch resets boards, reserves and result');

  // --- Premove: Carol (black, board A) queues e7-e5 while white to move ---
  await clickSquare(page, 'A', 'e7'); // black pawn -> premove selection
  await clickSquare(page, 'A', 'e5'); // queue it
  let pm = await page.evaluate(() => Game.premove.A);
  assert(pm && pm.kind === 'move' && pm.toR === 4 && pm.toF === 4, 'premove queued');
  const pmHl = await page.$eval('#board-A .square[data-r="4"][data-f="4"]',
    e => e.classList.contains('premove-to'));
  assert(pmHl, 'premove target square highlighted');
  await page.screenshot({ path: 'test/shots/05-premove.png' });

  await move(page, 'A', 'd2', 'd4'); // white moves -> premove fires
  await new Promise(res => setTimeout(res, 300));
  const e5p = await page.$eval('#board-A .square[data-r="4"][data-f="4"] .piece', e => [...e.classList]);
  assert(e5p.includes('p') && e5p.includes('b'), 'premove executed: black pawn appeared on e5');
  assert.strictEqual(await page.evaluate(() => Game.boards.A.turn), 'w',
    'turn passed back to white after premove executed');
  assert.strictEqual(await page.evaluate(() => Game.premove.A), null, 'premove slot cleared');

  // --- A premove that is illegal when the turn arrives is cancelled ---
  await clickSquare(page, 'A', 'a8'); // black rook
  await clickSquare(page, 'A', 'a6'); // geometric ray target, but a7 pawn blocks
  pm = await page.evaluate(() => Game.premove.A);
  assert(pm && pm.kind === 'move', 'blocked-rook premove queued (validated later)');
  await move(page, 'A', 'g1', 'f3'); // white moves
  await new Promise(res => setTimeout(res, 300));
  const a8r = await page.$eval('#board-A .square[data-r="7"][data-f="0"] .piece', e => [...e.classList]);
  assert(a8r.includes('r') && a8r.includes('b'), 'rook still on a8');
  assert.strictEqual(await page.evaluate(() => Game.premove.A), null, 'illegal premove cancelled');
  assert.strictEqual(await page.evaluate(() => Game.boards.A.turn), 'b',
    'black is on the move themselves after cancelled premove');

  // --- Promotion by removing a piece from the other board ---
  await page.evaluate(() => {
    const empty = () => Array.from({ length: 8 }, () => Array(8).fill(null));
    const put = (bd, r, f, type, color) => bd.board[r][f] = { type, color, promoted: false };
    const a = Game.boards.A;
    a.board = empty();
    put(a, 0, 4, 'k', 'w'); put(a, 7, 7, 'k', 'b');
    put(a, 6, 0, 'p', 'w'); // Pa7, ready to promote
    a.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
    a.turn = 'w'; a.ep = null;
    const bb = Game.boards.B;
    bb.board = empty();
    put(bb, 0, 4, 'k', 'w'); put(bb, 7, 7, 'k', 'b');
    put(bb, 3, 4, 'n', 'w'); // Ne4: pinned by re8 against Ke1
    put(bb, 0, 1, 'n', 'w'); // Nb1: free to take
    put(bb, 7, 4, 'r', 'b'); // re8
    bb.castling = { w: { k: false, q: false }, b: { k: false, q: false } };
    bb.turn = 'w'; bb.ep = null;
    Game.premove = { A: null, B: null };
    Game.preSel = { A: null, B: null };
    render();
  });
  await clickSquare(page, 'A', 'a7');
  await clickSquare(page, 'A', 'a8');
  await page.waitForSelector('#promo:not(.hidden)');
  const cands = await page.$$eval('#promo-choices .promo-sq', els => els.map(e => e.textContent));
  assert.deepStrictEqual(cands, ['b1'],
    `only the unpinned knight is offered (e4 is pinned), got ${JSON.stringify(cands)}`);
  await page.screenshot({ path: 'test/shots/06-promotion.png' });
  await page.click('#promo-choices button');
  const a8n = await page.$eval('#board-A .square[data-r="7"][data-f="0"] .piece', e => [...e.classList]);
  assert(a8n.includes('n') && a8n.includes('w'), 'pawn promoted to knight on a8');
  const b1sq = await page.$eval('#board-B .square[data-r="0"][data-f="1"] .piece', e => [...e.classList]);
  assert(!b1sq.includes('n'), 'knight removed from b1 on the other board');
  const promotedFlag = await page.evaluate(() => Game.boards.A.board[7][0].promoted);
  assert(promotedFlag, 'promoted piece flagged (reverts to pawn when captured)');

  await browser.close();
  console.log('All UI tests passed.');
})().catch(e => { console.error(e); process.exit(1); });
