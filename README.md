# TIDEHOLM — Stage 1

An original hex settlement-and-trading game. Full base ruleset, 3D cel-shaded board,
two play modes, authoritative server. Not affiliated with Catan or Catan GmbH.

## Repo layout

```
index.html        the game
engine.js         rules engine — shared by browser and server, do not duplicate
api/game.js       authoritative server (CommonJS — Vercel Node 20)
manifest.json     PWA manifest
sw.js             service worker (app shell cached, /api never cached)
icon-192.png
icon-512.png
test.js           1211 engine assertions
test-api.js       51 server assertions against a fake Redis
test-local.js     36 pass-and-play handover assertions
test-boot.js      12 boot assertions — proves the title buttons work even when
                  three.js or engine.js fails to load
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

## If the title buttons do nothing

They can't any more — but if the board never appears, an overlay will now tell you
why. The two usual causes:

- **engine.js is missing.** It has to be committed next to index.html at the repo
  root. It is not inlined, on purpose: the browser and the server load the same
  file so the rules can never diverge.
- **three.js was blocked.** It comes from cdnjs, with a unpkg fallback. Corporate
  and school networks sometimes block both. The service worker caches it after the
  first successful load, so offline play works from then on.

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
