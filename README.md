# Bughouse 2v2 Chess

A two-board, four-player team chess game (bughouse variant) with custom house
rules. Play **online** (room codes, four browsers) or **local hotseat**
(four players, one screen).

## How it works

- **Teams:** Team 1 = White on board A + Black on board B.
  Team 2 = Black on board A + White on board B. You always see your own
  board on the left, from your side; your teammate's board is beside it.
- **Captures feed your teammate:** when you capture a piece, it appears in
  your teammate's reserve on the other board. Click a reserve piece, then an
  empty highlighted square, to drop it — or simply drag it onto the board.
  While placing, hovering a legal square shows a translucent ghost preview.
- **Moving:** click-click or drag-and-drop. During a drag the origin piece
  fades and legal hovered squares are highlighted.
- **Premoves:** while waiting for your opponent you may queue one move or
  reserve drop (shown in purple). It executes the instant your turn arrives,
  or is silently cancelled if it turned out illegal. Use drag for premove
  captures; right-click the board to cancel. Premoved promotions auto-pick
  the strongest available piece.
- **Clocks:** every player has their own clock; both boards run
  simultaneously. Online, the server owns the clocks and the clients
  interpolate between syncs.
- **Requesting pieces:** use the "Ask for" buttons in your panel. Your
  teammate gets a pulsing badge, and the matching enemy pieces on their
  board glow so they know what to hunt.

## House rules

- A drop may **never give check** to the opponent.
- A **pawn** may not be dropped on your relative **7th or 8th rank**
  (ranks 1–2 for Black), nor on your own back rank.
- **Promotion takes a piece from the other board:** you promote by removing
  a knight/bishop/rook/queen of your own color from the other board (it
  belongs to the opposing team's player there). A piece whose removal would
  leave a king in check on that board — a pinned piece — cannot be taken.
  If nothing can be taken, the pawn cannot promote (the move is illegal).
- Promoted pieces **revert to pawns** when captured.
- A checkmate that could be averted by a future drop (e.g. a blockable
  back-rank check) is **not** mate — the player may sit and wait for
  material while their clock runs. Only unstoppable mates (contact and
  knight checks with no escape) end the game.
- The match ends for both boards on the first checkmate or flag fall.
  Stalemate on either board draws the match.

## Online play

The server is authoritative: it validates every move, drop and promotion
with the same `engine.js` the browser uses, runs the clocks, and broadcasts
state. Clients only send intents, so nobody can move out of turn or forge
actions for another board.

- One player clicks **Create game** (their time control is used) and shares
  the 6-character room code.
- Everyone joins with the code and picks a seat; the game starts
  automatically when all four seats are taken.
- If someone's connection drops, their seat is held — the client
  reconnects automatically and resumes with full state. Any player can
  trigger a **rematch** from the game-over screen.

## Run locally

```
npm install
npm start          # http://localhost:8080 — online play and hotseat
```

Opening `index.html` directly from disk also works for hotseat play only.

## Deploy to Render (free)

1. Push this folder to a GitHub repository.
2. On [render.com](https://render.com): **New → Web Service**, connect the
   repo. Render reads `render.yaml` (Node web service, `npm install`,
   `npm start`) — or set those two commands manually. Pick the **Free** plan.
3. That's it: one service serves both the site and the WebSocket at the
   same URL. Share `https://<your-app>.onrender.com` with your friends.

Note: free Render services sleep after ~15 idle minutes; the first visitor
after that waits ~30–60 s for the cold start. Active games are unaffected
(the server stays awake while connections are open), but a game in progress
does not survive a service restart/redeploy.

## Development

```
npm test           # engine rules + local UI + online multiplayer (4 headless pages)
npm run test:engine
npm run test:ui    # uses local Chrome via puppeteer-core
npm run test:online
```

- `engine.js` — single-board chess rules, drop legality, bughouse mate
  logic, promotion-by-removal helpers (shared by browser and server)
- `app.js` — client: rendering, drag-and-drop, premoves, local hotseat
  mode, and the online protocol
- `server.js` — authoritative server: static files, WebSocket rooms,
  validation, clocks, reconnection
- `pieces/` — "staunty" SVG piece set by sadsnake1, from
  [lichess](https://github.com/lichess-org/lila) (CC BY-NC-SA 4.0)
