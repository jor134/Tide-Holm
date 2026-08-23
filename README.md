# TIDEHOLM — Stage 1

An original hex settlement-and-trading game. Full base ruleset, 3D cel-shaded board,
two play modes, authoritative server. Not affiliated with Catan or Catan GmbH.

## Repo layout

```
index.html        the game
engine.js         rules engine — shared by browser and server, do not duplicate
bot.js            AI opponents — shared by browser and tests
save.js           saving and resuming local games
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

## Saving

Local games — solo and pass-and-play — autosave after every action, human or
bot. The title screen offers **Resume game** with a one-line summary. A finished
game clears its own save. Starting a new local game asks before overwriting.

The board is not stored. It is fully determined by the seed, so a save keeps the
seed plus a fingerprint of the board it expects, and regenerates the rest on
load. That is 1.5 KB instead of 18 KB. If board generation ever changes, the
fingerprint stops matching and the save is refused with an explanation, rather
than loading a game whose settlements sit on the wrong hexes. **If you change
genBoard() in Stage 2, bump `FORMAT` in save.js** so old saves fail cleanly.

A save is plain text in localStorage and the player can edit it. `validate()`
checks structure, ranges, and resource conservation before the state reaches the
engine, so an edited save that hands someone 20 of everything is rejected. This
is not real anti-cheat and is not meant to be — it is solo play on the player's
own device. It exists so a corrupted save fails loudly instead of producing a
broken game.

**iOS caveat worth knowing:** Safari deletes script-writable storage after seven
days without a visit. Installing to the home screen exempts the app, so a saved
solo game only reliably survives if Tideholm is installed rather than run in a
browser tab.

Remote games are not saved locally — the server already holds that state, and
tables expire after 48 hours.

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

## Tile decoration

The number token owns a reserved disc in the middle of every tile
(`TOKEN_CLEAR`, radius 0.40) and all terrain props live in the ring outside it.
Placements are a data table, `DECOR`, between the `DECOR-START` and `DECOR-END`
markers in index.html. test-geometry.js evaluates that block directly, so the
test can never drift from what renders.

Two rules for anything added there:
- inner edge (`distance - r`) must be at least `TOKEN_CLEAR`, or it covers the number
- outer edge (`distance + r`) must be within `HEX_INRADIUS` (0.831), or it spills onto the next tile

Props placed by eye will break the first rule. The original clay pit was a
radius-0.5 disc at the tile centre, which hid its number entirely except during
the moment the token lifts on a matching roll — four of the five terrain types
had the same fault to a lesser degree.

The raider stands on top of the number disc rather than through it. It is
narrower than the token, so the digits still read.

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
