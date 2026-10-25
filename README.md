# 🏆 BuildRoyale

A **Fortnite-style battle royale** that runs entirely in the browser — move, shoot,
**build walls for cover**, survive the **shrinking storm**, and be the last one standing.

It's fully **peer-to-peer** (WebRTC via [PeerJS](https://peerjs.com/)): one player
hosts a match and shares a room code, friends connect **browser-to-browser** — no
game server to run or pay for. That's why it drops straight onto **GitHub Pages**.

## Play

- **Solo vs bots** — click *Play solo vs bots*, instant drop-in.
- **With friends** — one person clicks *Host a match* and shares the 6-character
  room code. Everyone else enters it and clicks *Join*. Host clicks *Drop in!*.

### Controls

| Key | Action | Key | Action |
|-----|--------|-----|--------|
| `WASD` | Move | `Q` | Build wall |
| Mouse | Aim | `F` | Build ramp |
| Click | Shoot | `R` | Reload |
| `1` / `2` | Switch weapon | `E` | Pick up loot |
| `Shift` | Sprint | | |

Walls cost **10 materials**. Pick up loot (`E`) for weapons, shield, and mats.
Stay inside the purple storm circle — it closes in and hurts more each phase.

## How the netcode works

Host-authoritative star topology:

- The **host** runs the whole simulation and broadcasts ~20 snapshots/sec.
- **Clients** send their input up and render interpolated snapshots down, with
  light client-side prediction on their own movement so it feels responsive.
- Matchmaking uses PeerJS's free public broker only to introduce peers; the actual
  gameplay traffic is direct WebRTC between browsers.

> Because it relies on the public STUN/broker, some strict/symmetric NATs may fail
> to connect directly. For a production deployment, point PeerJS at your own
> PeerServer + a TURN server (see `js/net.js`).

## Host it on GitHub Pages

This is a static site — no build step.

1. Create a repo and push these files (see commands below).
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch**, pick `main` / `/ (root)`, **Save**.
3. Your game is live at `https://<user>.github.io/<repo>/`.

```bash
git init
git add .
git commit -m "BuildRoyale: p2p browser battle royale"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```

## Project layout

```
index.html      menu / lobby / HUD markup
css/style.css   all styling
js/net.js       WebRTC transport (PeerJS wrapper)
js/game.js      simulation, rendering, input, bots
```

## License

MIT — do whatever you want.
