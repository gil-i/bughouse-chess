'use strict';
/* Online end-to-end test: starts server.js, connects 4 headless pages,
 * and plays a multiplayer sequence across both boards. */
const path = require('path');
const assert = require('assert');
const { spawn } = require('child_process');
const http = require('http');
const puppeteer = require('puppeteer-core');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 8417;
const URL = `http://localhost:${PORT}`;

function waitForServer(timeout = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    (function ping() {
      http.get(URL, () => resolve()).on('error', () => {
        if (Date.now() - start > timeout) reject(new Error('server did not start'));
        else setTimeout(ping, 150);
      });
    })();
  });
}

async function waitFor(page, fn, what, timeout = 6000) {
  const start = Date.now();
  for (;;) {
    const v = await page.evaluate(fn);
    if (v) return v;
    if (Date.now() - start > timeout) throw new Error(`timeout waiting for: ${what}`);
    await new Promise(res => setTimeout(res, 120));
  }
}

async function clickSquare(page, boardId, alg) {
  const f = alg.charCodeAt(0) - 97;
  const r = +alg[1] - 1;
  await page.click(`#board-${boardId} .square[data-r="${r}"][data-f="${f}"]`);
}

async function move(page, boardId, from, to) {
  await clickSquare(page, boardId, from);
  await new Promise(res => setTimeout(res, 60));
  await clickSquare(page, boardId, to);
}

(async () => {
  const server = spawn('node', [path.resolve(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'inherit',
  });
  try {
    await waitForServer();
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true });

    const NAMES = ['Alice', 'Carol', 'Dave', 'Bob']; // p0..p3
    const SEATS = ['A-w', 'A-b', 'B-w', 'B-b'];
    const pages = [];
    for (let i = 0; i < 4; i++) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1500, height: 1000 });
      page.on('pageerror', e => { console.error(`PAGE ${i} ERROR:`, e.message); process.exitCode = 1; });
      await page.goto(URL);
      pages.push(page);
    }
    const [pAlice, pCarol, pDave, pBob] = pages;

    // --- Alice creates a 3+2 game ---
    await pAlice.type('#online-name', 'Alice');
    await pAlice.evaluate(() => {
      [...document.querySelectorAll('#tc-presets button')].find(b => b.textContent === '3+2').click();
    });
    await pAlice.click('#create-btn');
    const code = await waitFor(pAlice, () => {
      const c = document.querySelector('#lobby-code');
      return c && c.textContent.length === 6 ? c.textContent : null;
    }, 'lobby code');

    // --- Others join with the code ---
    for (let i = 1; i < 4; i++) {
      await pages[i].type('#online-name', NAMES[i]);
      await pages[i].type('#join-code', code);
      await pages[i].click('#join-btn');
      await waitFor(pages[i], () => !document.querySelector('#lobby').classList.contains('hidden'), `p${i} in lobby`);
    }

    // --- Everyone sits; game auto-starts when all 4 seats taken ---
    for (let i = 0; i < 4; i++) {
      await pages[i].evaluate(seat => {
        const btns = [...document.querySelectorAll('.seat-btn:not(.taken)')];
        const labels = { 'A-w': 'White · Board A', 'A-b': 'Black · Board A', 'B-w': 'White · Board B', 'B-b': 'Black · Board B' };
        const btn = btns.find(b => b.querySelector('.seat-label').textContent === labels[seat]);
        btn.click();
      }, SEATS[i]);
      await new Promise(res => setTimeout(res, 200));
    }
    for (let i = 0; i < 4; i++) {
      await waitFor(pages[i], () => !document.querySelector('#game').classList.contains('hidden'), `p${i} sees game`);
    }

    // --- Orientation: Carol (A-b, team 2) sees board A flipped and on the left ---
    const carolView = await pCarol.evaluate(() =>
      ({ flippedA: View.flipped.A, orderA: document.querySelector('#col-A').style.order }));
    assert.strictEqual(carolView.flippedA, true, 'Carol sees board A from black side');
    assert.strictEqual(carolView.orderA, '0', 'Carol sees her own board on the left');
    const bobView = await pBob.evaluate(() =>
      ({ flippedB: View.flipped.B, orderB: document.querySelector('#col-B').style.order }));
    assert.strictEqual(bobView.flippedB, true, 'Bob (B-b) sees board B from black side');
    assert.strictEqual(bobView.orderB, '0', 'Bob sees board B on the left');

    // --- Permissions: Alice cannot select Carol's pieces (no premove selection) ---
    await clickSquare(pAlice, 'A', 'e7');
    const noPre = await pAlice.evaluate(() => Game.preSel.A === null && Game.selected.A === null);
    assert(noPre, "Alice can't grab black pieces on board A");

    // --- Alice plays 1.e4; everyone sees it ---
    await move(pAlice, 'A', 'e2', 'e4');
    for (const [i, p] of pages.entries()) {
      await waitFor(p, () => {
        const x = Game.boards && Game.boards.A.board[3][4];
        return x && x.type === 'p' && x.color === 'w';
      }, `p${i} sees e4`);
    }

    // --- Carol replies 1...d5; Alice captures 2.exd5 -> Bob (B-b) gets a pawn ---
    await move(pCarol, 'A', 'd7', 'd5');
    await waitFor(pAlice, () => Game.boards.A.turn === 'w', 'Alice to move');
    await move(pAlice, 'A', 'e4', 'd5');
    for (const [i, p] of pages.entries()) {
      await waitFor(p, () => Game.boards.B.reserves.b.p === 1, `p${i} sees Bob's reserve pawn`);
    }

    // --- Board B: Dave plays d4, then Bob drops his pawn on e6 ---
    await move(pDave, 'B', 'd2', 'd4');
    await waitFor(pBob, () => Game.boards.B.turn === 'b', 'Bob to move');
    await pBob.click('#reserve-B-b .chip[data-type="p"]');
    await clickSquare(pBob, 'B', 'e6');
    for (const [i, p] of pages.entries()) {
      await waitFor(p, () => {
        const x = Game.boards.B.board[5][4];
        return x && x.type === 'p' && x.color === 'b';
      }, `p${i} sees dropped pawn on e6`);
    }
    assert.strictEqual(await pBob.evaluate(() => Game.boards.B.reserves.b.p), 0, 'reserve consumed');

    // --- Server rejects a forged move: Alice tries to act on board B ---
    await pAlice.evaluate(() => netSend({ t: 'move', board: 'B', fromR: 1, fromF: 0, toR: 2, toF: 0 }));
    await new Promise(res => setTimeout(res, 300));
    const a2B = await pBob.evaluate(() => {
      const x = Game.boards.B.board[1][0];
      return x && x.type === 'p' && x.color === 'w';
    });
    assert(a2B, "Alice's forged move on board B was rejected");

    // --- Request: Alice asks for a knight; Bob sees the badge ---
    await pAlice.evaluate(() => {
      document.querySelectorAll('#panel-A-w .req-btns button')[1].click();
    });
    await waitFor(pBob, () => document.querySelector('#badge-B-b').classList.contains('show'), 'Bob sees badge');

    // --- Carol recaptures so it's white's turn, then queues a premove ---
    await waitFor(pCarol, () => Game.boards.A.turn === 'b', 'Carol to move on A');
    await move(pCarol, 'A', 'd8', 'd5'); // qxd5 (Dave receives a white pawn)
    await waitFor(pCarol, () => Game.boards.A.turn === 'w', 'white to move on A');
    await clickSquare(pCarol, 'A', 'a7');
    await clickSquare(pCarol, 'A', 'a6');
    const pmQueued = await pCarol.evaluate(() => Game.premove.A && Game.premove.A.kind === 'move');
    assert(pmQueued, 'Carol queued a premove');
    await move(pAlice, 'A', 'g1', 'f3'); // Alice moves; Carol's premove should fire
    for (const [i, p] of pages.entries()) {
      await waitFor(p, () => {
        const x = Game.boards.A.board[5][0];
        return x && x.type === 'p' && x.color === 'b';
      }, `p${i} sees Carol's premoved a6`);
    }

    // --- Clocks: increments applied server-side, clocks sync to all ---
    // Bob's clock ran only for the moment of his single drop, then gained
    // +2s increment, so it must sit above base time — on everyone's screen.
    const bobClock = await pDave.evaluate(() => Game.clocks.B.b);
    assert(bobClock > 3 * 60000,
      `Bob's clock should exceed base via increment, got ${bobClock}`);
    const t1 = await pBob.evaluate(() => Game.clocks.A[Game.boards.A.turn]);
    await new Promise(res => setTimeout(res, 1500));
    const t2 = await pBob.evaluate(() => Game.clocks.A[Game.boards.A.turn]);
    assert(t2 < t1, 'active clock ticks down on a non-moving client');

    await pages[0].screenshot({ path: 'test/shots/08-online-alice.png' });
    await pages[1].screenshot({ path: 'test/shots/09-online-carol.png' });

    // --- Reconnect: Bob drops his connection and rejoins with his token ---
    await pBob.evaluate(() => Net.ws.close());
    await waitFor(pAlice, () => {
      const n = document.querySelector('#pname-B-b').textContent;
      return n.includes('offline');
    }, 'Alice sees Bob offline');
    await waitFor(pBob, () => Net.ws && Net.ws.readyState === 1 && !Net.reconnecting, 'Bob reconnected', 10000);
    await waitFor(pAlice, () => !document.querySelector('#pname-B-b').textContent.includes('offline'),
      'Alice sees Bob back online');

    // --- Bob can still play after reconnecting ---
    await waitFor(pBob, () => Game.boards.B.turn === 'w', 'white to move on B');
    await move(pDave, 'B', 'c1', 'f4');
    await waitFor(pBob, () => Game.boards.B.turn === 'b', 'Bob to move after reconnect');
    await move(pBob, 'B', 'g8', 'f6');
    await waitFor(pDave, () => {
      const x = Game.boards.B.board[5][5];
      return x && x.type === 'n' && x.color === 'b';
    }, 'Dave sees Bob\'s post-reconnect move');

    await browser.close();
    console.log('All online tests passed.');
  } finally {
    server.kill();
  }
})().catch(e => { console.error(e); process.exit(1); });
