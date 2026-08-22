# TIDEHOLM — Stage 1

An original hex settlement-and-trading game. Full base ruleset, 3D cel-shaded board,
two play modes, authoritative server. Not affiliated with Catan or Catan GmbH.

## Repo layout

```
index.html        the game
engine.js         rules engine — shared by browser and server, do not duplicate
bot.js            AI opponents — shared by browser and tests
api/game.js       authoritative server (CommonJS — Vercel Node 20)
manifest.json     PWA manifest
sw.js             service worker (app shell cached, /api never cached)
icon-192.png
icon-512.png
test.js           1211 engine assertions
test-api.js       51 server assertions against a fake Redis
test-local.js     36 pass-and-play handover assertions
```

Commit all of these at the repo root, `api/game.js` in an `api/` folder.
Vercel picks up `api/*.js` as serverless functions automatically. No build step,
no config file needed.

## Storage setup (required for remote play)

1. Vercel dashboard → Storage → create or attach an **Upstash Redis** store to this project.
2. Redeploy so the environment variables are injected.

`api/game.js` scans for the REST pair under several names
(`UPSTASH_REDIS_REST_URL` / `_TOKEN`, `KV_REST_API_URL` / `_TOKEN`, or anything
ending in `REST_API_URL` / `REST_API_TOKEN`), so whichever way the store is
attached should work. Pass-and-play works with no storage at all.

Tables expire after 48 hours.

## What is and isn't in Stage 1

In: settlements, cities, roads, dice production, the raider, the seven-card
discard, ports at 3:1 and 2:1, all five development card types, player-to-player
trading, Long Road, Standing Guard, hidden victory point cards, 2–6 players.

Not in: the Seafarers-style variant (ships, islands, gold hexes). That is Stage 2.

## Bots

Three levels. Every level plays by the same rules — no bonus resources at any
difficulty, and all of them reason from `E.redact(state, ownId)`, the same
censored view a human gets. They cannot see your hand or the deck.

| | Placement | Stores | Opens trades | Watches the leader |
|---|---|---|---|---|
| Casual | loose | no | no | no |
| Steady | decent | yes | yes | no |
| Sharp | best | yes | yes | yes |

Measured over 120 games per pairing, seats alternated:

| Matchup | Win rate |
|---|---|
| Sharp vs Casual | 78% |
| Steady vs Casual | 76% |
| Sharp vs Steady | 62% |
| One Sharp among three Steady | 50% (chance is 25%) |
| One Steady among three Casual | 60% (chance is 25%) |

Sharp is a competent opponent, not a strong one. It has no search and no real
model of what you are collecting; an attentive human beats it.

Bots run client-side only, driven by `botTick()` in index.html, one action per
tick with a readable pause. They work offline. They are deliberately **not**
available in remote tables — nothing there decides which client is responsible
for ticking a bot, and two clients ticking the same bot would double-move it.

If you add a level, re-run test-bot.js: it asserts the ladder is ordered and
that no level touches hands, the bank, or the deck directly.

## Hex orientation

The board is pointy-top: circumradius 1, neighbours sqrt(3) apart.

three.js `CylinderGeometry` builds its torso with `x = r*sin(theta)` and
`z = r*cos(theta)`, so a 6-segment prism already has a vertex at +Z — the same
orientation as the engine lattice. **`HEX_YAW` must stay 0.** Rotating by 30
degrees turns the flat edges into points that jut 0.19 units into every
neighbour, which is what the overlapping tiles were.

`HEX_R_DRAW` (0.96) and `HEX_OUTLINE` (1.035) must satisfy
`2 * R * OUTLINE * cos(30) < sqrt(3)` or the outlines will overlap and z-fight.
Current clearance is a 0.011-unit seam. test-geometry.js enforces all of this
and does an exhaustive separating-axis check on all 171 hex pairs.

## Camera

`fitCamera()` computes the distance at which the board's bounding sphere
(`BOARD_R`, 5.9 world units) fits inside both the vertical and horizontal
frustum, and widens the field of view to 58 degrees on viewports narrower than
3:4. On a portrait phone the horizontal field is the binding constraint by a
wide margin — a fixed distance tuned by eye will always clip the sides.

Zoom limits are multiples of the fitted distance, never absolute numbers.
Double tap the board, or tap the ⤢ button, to refit.

If you change the board size in Stage 2 (Seafarers adds sea hexes), raise
`BOARD_R` to match or the board will overflow the screen again. test-camera.js
will fail if you forget.

## Known limitations

- **Longest road uses exhaustive DFS.** Correct, including breaks by enemy
  settlements, but it is exponential in road-network branching. Fifteen roads is
  the hard ceiling per player so it stays fast. Do not lift the piece limit
  without replacing the algorithm.
- **Polling, not push.** Remote play refreshes every 1.6 seconds. Turn-based, so
  this is fine, but a trade offer can sit for a beat before the other phones show it.
- **No reconnect grace.** If someone closes the tab mid-game their seat stays;
  rejoining with the same browser restores it (the player id is kept in
  localStorage). A different device cannot claim that seat.
- **Trade offers go to the whole table.** First acceptance wins. There is no
  counter-offer flow.
- **Six-player boards use the standard 19-hex layout.** Official six-player Catan
  uses an extended board; this does not. Five and six players will feel cramped.
- **Locking is a Redis SET NX with a 4-second expiry.** Adequate for turn-based
  traffic. It is not a general-purpose transaction.
