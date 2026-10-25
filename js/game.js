/* game.js — BuildRoyale
 *
 * A top-down battle-royale: move, shoot, build walls for cover, survive the
 * shrinking storm, be the last one standing.
 *
 * Networking model: HOST-AUTHORITATIVE STAR.
 *   - The host runs the whole simulation (players, bullets, structures,
 *     storm, loot, bots) and broadcasts ~20 snapshots/sec.
 *   - Clients send their input up and render interpolated snapshots down,
 *     with light client-side prediction on their own movement so it feels
 *     responsive despite the round-trip.
 *   - Solo mode is just "host with no clients + bots".
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- config
  var MAP = 2800;              // square world, px
  var CELL = 48;               // build grid size
  var PLR_R = 16;              // player radius
  var SNAP_HZ = 20;            // snapshots / inputs per second
  var SIM_DT = 1 / 60;        // physics step
  var STORM_DPS = [1, 2, 4, 7, 12, 20]; // damage per phase, per second
  var MAX_MATS = 500;

  var WEAPONS = {
    pistol:  { name: "Pistol",  dmg: 18, rate: 320, spread: 0.04, speed: 760, pellets: 1, mag: 12, reserve: 60, reload: 900,  range: 620, color: "#d7d7d7" },
    smg:     { name: "SMG",     dmg: 13, rate: 95,  spread: 0.11, speed: 760, pellets: 1, mag: 30, reserve: 120, reload: 1500, range: 520, color: "#8fd0ff" },
    ar:      { name: "Rifle",   dmg: 26, rate: 150, spread: 0.055,speed: 900, pellets: 1, mag: 25, reserve: 90, reload: 1800, range: 820, color: "#9b6bff" },
    shotgun: { name: "Shotgun", dmg: 9,  rate: 750, spread: 0.26, speed: 680, pellets: 8, mag: 6,  reserve: 36, reload: 2000, range: 320, color: "#ff9f5a" },
    sniper:  { name: "Sniper",  dmg: 95, rate: 1400,spread: 0.0,  speed: 1500,pellets: 1, mag: 4,  reserve: 16, reload: 2400, range: 1500,color: "#ff5d6c" }
  };
  var LOOT_WEAPONS = ["smg", "ar", "shotgun", "sniper"];

  // ---------------------------------------------------------------- helpers
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function dist2(ax, ay, bx, by) { var dx = ax - bx, dy = ay - by; return dx * dx + dy * dy; }
  function now() { return performance.now(); }

  // Seeded RNG so every peer generates the identical map from one number.
  function mulberry32(seed) {
    return function () {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- DOM
  var $ = function (id) { return document.getElementById(id); };
  var screens = { menu: $("menu"), lobby: $("lobby"), game: $("game"), over: $("over") };
  function show(name) {
    for (var k in screens) screens[k].classList.add("hidden");
    screens[name].classList.remove("hidden");
  }

  var canvas = $("canvas"), ctx = canvas.getContext("2d");
  var mini = $("miniCanvas"), mctx = mini.getContext("2d");
  var W = 0, H = 0;
  function resize() {
    W = canvas.width = Math.floor(window.innerWidth);
    H = canvas.height = Math.floor(window.innerHeight);
  }
  window.addEventListener("resize", resize); resize();

  // ================================================================ STATE
  var net = new Net();
  var role = null;            // "host" | "client"
  var myName = "Player";
  var myId = null;            // id of my player in the sim
  var seed = 0;
  var world = { walls: [], obstacles: [], loot: [] }; // obstacles are static; from seed

  // Authoritative sim lives on the host:
  var sim = null;             // host only

  // What the client renders (host builds this too, from its own sim):
  var render = {
    players: {}, bullets: [], walls: [], loot: [],
    storm: { cx: MAP / 2, cy: MAP / 2, r: MAP, nextR: MAP, phase: 0, timer: 0 },
    alive: 1, started: false
  };
  var prevSnap = null, lastSnap = null, snapTime = 0; // interpolation

  // Local input + prediction for own player:
  var keys = {};
  var mouse = { x: 0, y: 0, down: false };
  var input = { ax: 0, ay: 0, aim: 0, shoot: false, build: 0, reload: false, pickup: false, swap: 0, sprint: false };
  var predict = { x: MAP / 2, y: MAP / 2, has: false };
  var cam = { x: MAP / 2, y: MAP / 2 };

  // ================================================================ WORLD GEN
  // Deterministic generation using only the seeded generator (no Math.random),
  // so the host and every client build the identical map from one seed number.
  function rebuildDeterministic(s) {
    var r = mulberry32(s);
    var R = function (a, b) { return a + r() * (b - a); };
    var obstacles = [], loot = [];
    for (var i = 0; i < 90; i++) {
      var x = R(140, MAP - 140), y = R(140, MAP - 140);
      if (dist2(x, y, MAP / 2, MAP / 2) < 300 * 300) continue;
      var type = r() < 0.5 ? "rock" : "tree";
      obstacles.push({ x: x, y: y, r: type === "rock" ? R(26, 46) : R(18, 26), type: type });
    }
    for (var j = 0; j < 55; j++) {
      var lx = R(120, MAP - 120), ly = R(120, MAP - 120);
      var roll = r(), item;
      if (roll < 0.5) item = { kind: "weapon", w: LOOT_WEAPONS[(r() * LOOT_WEAPONS.length) | 0] };
      else if (roll < 0.78) item = { kind: "shield" };
      else item = { kind: "mats" };
      item.x = lx; item.y = ly; item.id = "L" + j; item.taken = false;
      loot.push(item);
    }
    return { obstacles: obstacles, loot: loot };
  }

  // ================================================================ PLAYER FACTORY
  function makePlayer(id, name, bot) {
    // spawn on a ring around the center
    var a = Math.random() * Math.PI * 2, rad = rnd(700, 1200);
    return {
      id: id, name: name || "Player", bot: !!bot,
      x: MAP / 2 + Math.cos(a) * rad, y: MAP / 2 + Math.sin(a) * rad,
      aim: 0, hp: 100, shield: 0, mats: 100, alive: true, kills: 0,
      weapons: { pistol: { mag: WEAPONS.pistol.mag, reserve: WEAPONS.pistol.reserve } },
      slot: "pistol", slots: ["pistol"],
      lastShot: 0, reloading: 0, dmgFlash: 0,
      // control intents (filled from input / AI each tick)
      ax: 0, ay: 0, shoot: false, buildReq: 0, reloadReq: false, pickupReq: false, swapReq: 0, sprint: false,
      // bot ai memory
      aiTarget: null, aiRepath: 0, aiBuild: 0
    };
  }

  // ================================================================ HOST SIM
  function startSim() {
    sim = {
      players: {}, bullets: [], walls: [], feed: [],
      storm: { cx: MAP / 2 + rnd(-300, 300), cy: MAP / 2 + rnd(-300, 300), r: MAP * 0.72, nextR: MAP * 0.72, phase: 0, timer: 22 },
      started: true, acc: 0, last: now(), bid: 0, over: false
    };
    // host's own player
    sim.players[myId] = makePlayer(myId, myName, false);
    // existing connected clients
    for (var pid in net.conns) sim.players[pid] = makePlayer(pid, clientNames[pid] || "Player", false);
    // fill with bots up to 10 combatants
    var count = Object.keys(sim.players).length;
    for (var b = count; b < 10; b++) {
      var bid = "BOT" + b;
      sim.players[bid] = makePlayer(bid, BOT_NAMES[b % BOT_NAMES.length], true);
    }
    world.loot = rebuildDeterministic(seed).loot;
  }
  var BOT_NAMES = ["Ghost", "Viper", "Nova", "Rex", "Blaze", "Echo", "Zephyr", "Onyx", "Lynx", "Hex"];
  var clientNames = {};

  function wallKey(gx, gy) { return gx + "," + gy; }

  function placeWall(p, kind) {
    if (p.mats < 10) return;
    // place one cell in front of the player, grid-aligned
    var fx = p.x + Math.cos(p.aim) * 44, fy = p.y + Math.sin(p.aim) * 44;
    var gx = Math.floor(fx / CELL), gy = Math.floor(fy / CELL);
    for (var i = 0; i < sim.walls.length; i++)
      if (sim.walls[i].gx === gx && sim.walls[i].gy === gy) return; // occupied
    p.mats -= 10;
    sim.walls.push({ gx: gx, gy: gy, x: gx * CELL + CELL / 2, y: gy * CELL + CELL / 2, hp: 120, owner: p.id, ramp: kind === 2 });
  }

  function giveWeapon(p, w) {
    if (!p.weapons[w]) {
      p.weapons[w] = { mag: WEAPONS[w].mag, reserve: WEAPONS[w].reserve };
      p.slots.push(w);
    } else {
      p.weapons[w].reserve = Math.min(WEAPONS[w].reserve * 2, p.weapons[w].reserve + WEAPONS[w].reserve);
    }
    p.slot = w;
  }

  function fire(p, t) {
    var W = WEAPONS[p.slot], wk = p.weapons[p.slot];
    if (!wk || p.reloading) return;
    if (t - p.lastShot < W.rate) return;
    if (wk.mag <= 0) { p.reloading = t + W.reload; return; }
    p.lastShot = t; wk.mag--;
    for (var i = 0; i < W.pellets; i++) {
      var ang = p.aim + (Math.random() - 0.5) * 2 * W.spread;
      sim.bullets.push({
        id: sim.bid++, x: p.x + Math.cos(ang) * (PLR_R + 4), y: p.y + Math.sin(ang) * (PLR_R + 4),
        vx: Math.cos(ang) * W.speed, vy: Math.sin(ang) * W.speed,
        dmg: W.dmg, owner: p.id, life: W.range / W.speed, color: W.color
      });
    }
    if (wk.mag <= 0) p.reloading = t + W.reload;
  }

  function hurt(p, dmg, byId) {
    if (!p.alive) return;
    p.dmgFlash = 6;
    if (p.shield > 0) {
      var s = Math.min(p.shield, dmg); p.shield -= s; dmg -= s;
    }
    p.hp -= dmg;
    if (p.hp <= 0) {
      p.hp = 0; p.alive = false;
      var killer = sim.players[byId];
      if (killer && byId !== p.id) killer.kills++;
      sim.feed.push({ txt: (killer ? killer.name : "Storm") + " ✗ " + p.name, t: now() });
      // drop some mats as loot
      world.loot.push({ id: "D" + sim.bid++, kind: "mats", x: p.x, y: p.y, taken: false });
    }
  }

  // --- collision: resolve a player circle against walls + obstacles
  function collide(p) {
    // world bounds
    p.x = clamp(p.x, PLR_R, MAP - PLR_R);
    p.y = clamp(p.y, PLR_R, MAP - PLR_R);
    // obstacles (circles)
    for (var i = 0; i < world.obstacles.length; i++) {
      var o = world.obstacles[i], rr = o.r + PLR_R;
      var dx = p.x - o.x, dy = p.y - o.y, d2 = dx * dx + dy * dy;
      if (d2 < rr * rr && d2 > 0.01) {
        var d = Math.sqrt(d2), push = (rr - d);
        p.x += (dx / d) * push; p.y += (dy / d) * push;
      }
    }
    // walls (AABB vs circle)
    for (var j = 0; j < sim.walls.length; j++) {
      var w = sim.walls[j]; if (w.ramp) continue;
      var half = CELL / 2;
      var nx = clamp(p.x, w.x - half, w.x + half);
      var ny = clamp(p.y, w.y - half, w.y + half);
      var ddx = p.x - nx, ddy = p.y - ny, dd2 = ddx * ddx + ddy * ddy;
      if (dd2 < PLR_R * PLR_R && dd2 > 0.0001) {
        var dd = Math.sqrt(dd2), pp = PLR_R - dd;
        p.x += (ddx / dd) * pp; p.y += (ddy / dd) * pp;
      } else if (dd2 <= 0.0001) {
        p.x += PLR_R; // degenerate: nudge out
      }
    }
  }

  function simStep(dt) {
    var t = now();
    // ---- storm ----
    var st = sim.storm;
    st.timer -= dt;
    if (st.timer <= 0 && st.phase < STORM_DPS.length) {
      st.phase++;
      st.r = st.nextR;
      st.nextR = Math.max(140, st.r * 0.6);
      // new center drifts inside the current safe zone
      var a = Math.random() * Math.PI * 2, rr = (st.r - st.nextR) * 0.5 * Math.random();
      st.cx = clamp(st.cx + Math.cos(a) * rr, st.nextR, MAP - st.nextR);
      st.cy = clamp(st.cy + Math.sin(a) * rr, st.nextR, MAP - st.nextR);
      st.timer = 20;
    }
    // smoothly shrink r toward nextR over the phase
    if (st.r > st.nextR) st.r = Math.max(st.nextR, st.r - (MAP * 0.6) * dt / 20);

    // ---- players ----
    var aliveList = [];
    for (var id in sim.players) {
      var p = sim.players[id];
      if (p.bot) botThink(p, t);
      if (!p.alive) continue;
      aliveList.push(p);

      // movement
      var sp = p.sprint ? 285 : 205;
      var mag = Math.hypot(p.ax, p.ay);
      if (mag > 0.01) { p.x += (p.ax / mag) * sp * dt; p.y += (p.ay / mag) * sp * dt; }
      collide(p);

      // actions
      if (p.reloadReq) { doReload(p, t); p.reloadReq = false; }
      if (p.swapReq) { cycleSlot(p, p.swapReq); p.swapReq = 0; }
      if (p.buildReq) { placeWall(p, p.buildReq); p.buildReq = 0; }
      if (p.pickupReq) { pickup(p); p.pickupReq = false; }
      if (p.reloading && t >= p.reloading) finishReload(p);
      if (p.shoot && !p.reloading) fire(p, t);

      // storm damage
      if (dist2(p.x, p.y, st.cx, st.cy) > st.r * st.r) {
        hurt(p, STORM_DPS[Math.min(st.phase, STORM_DPS.length - 1)] * dt, "storm");
      }
      if (p.dmgFlash > 0) p.dmgFlash--;
    }

    // ---- bullets ----
    for (var b = sim.bullets.length - 1; b >= 0; b--) {
      var bu = sim.bullets[b];
      bu.x += bu.vx * dt; bu.y += bu.vy * dt; bu.life -= dt;
      var dead = bu.life <= 0 || bu.x < 0 || bu.y < 0 || bu.x > MAP || bu.y > MAP;
      // hit walls
      if (!dead) {
        for (var w = 0; w < sim.walls.length; w++) {
          var wl = sim.walls[w]; if (wl.ramp) continue;
          if (Math.abs(bu.x - wl.x) < CELL / 2 && Math.abs(bu.y - wl.y) < CELL / 2) {
            wl.hp -= bu.dmg; dead = true;
            if (wl.hp <= 0) sim.walls.splice(w, 1);
            break;
          }
        }
      }
      // hit obstacles (rocks block, trees block)
      if (!dead) {
        for (var o = 0; o < world.obstacles.length; o++) {
          var ob = world.obstacles[o];
          if (dist2(bu.x, bu.y, ob.x, ob.y) < ob.r * ob.r) { dead = true; break; }
        }
      }
      // hit players
      if (!dead) {
        for (var pi = 0; pi < aliveList.length; pi++) {
          var tp = aliveList[pi];
          if (tp.id === bu.owner) continue;
          if (dist2(bu.x, bu.y, tp.x, tp.y) < (PLR_R + 4) * (PLR_R + 4)) {
            hurt(tp, bu.dmg, bu.owner); dead = true; break;
          }
        }
      }
      if (dead) sim.bullets.splice(b, 1);
    }

    // trim feed
    sim.feed = sim.feed.filter(function (f) { return now() - f.t < 4000; });

    // ---- win check ----
    if (!sim.over) {
      var total = Object.keys(sim.players).length;
      if (aliveList.length <= 1 && total > 1) {
        sim.over = true;
        var winner = aliveList[0];
        sim.winnerId = winner ? winner.id : null;
      }
    }
  }

  function doReload(p, t) {
    var W = WEAPONS[p.slot], wk = p.weapons[p.slot];
    if (!wk || p.reloading || wk.mag >= W.mag || wk.reserve <= 0) return;
    p.reloading = t + W.reload;
  }
  function finishReload(p) {
    var W = WEAPONS[p.slot], wk = p.weapons[p.slot];
    var need = W.mag - wk.mag, take = Math.min(need, wk.reserve);
    wk.mag += take; wk.reserve -= take; p.reloading = 0;
  }
  function cycleSlot(p, dir) {
    var i = p.slots.indexOf(p.slot);
    i = (i + dir + p.slots.length) % p.slots.length;
    p.slot = p.slots[i];
  }
  function pickup(p) {
    for (var i = 0; i < world.loot.length; i++) {
      var it = world.loot[i];
      if (it.taken) continue;
      if (dist2(p.x, p.y, it.x, it.y) < 44 * 44) {
        if (it.kind === "weapon") giveWeapon(p, it.w);
        else if (it.kind === "shield") p.shield = Math.min(100, p.shield + 25);
        else if (it.kind === "mats") p.mats = Math.min(MAX_MATS, p.mats + 50);
        it.taken = true;
        return;
      }
    }
  }

  // ---------------------------------------------------------------- BOT AI
  function botThink(p, t) {
    if (!p.alive) return;
    var st = sim.storm;
    // find nearest living enemy
    var best = null, bd = 1e18;
    for (var id in sim.players) {
      var q = sim.players[id];
      if (!q.alive || q.id === p.id) continue;
      var d = dist2(p.x, p.y, q.x, q.y);
      if (d < bd) { bd = d; best = q; }
    }
    // default: drift toward storm safe-center
    var tx = st.cx, ty = st.cy;
    var outside = dist2(p.x, p.y, st.cx, st.cy) > (st.r * 0.85) * (st.r * 0.85);
    p.shoot = false;

    if (best && bd < 560 * 560 && !outside) {
      // engage
      var dx = best.x - p.x, dy = best.y - p.y;
      p.aim = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.12;
      p.shoot = Math.random() < 0.85;
      // strafe a bit instead of walking straight in
      var perp = p.aim + Math.PI / 2 * (Math.sin(t / 700 + p.x) > 0 ? 1 : -1);
      var want = Math.sqrt(bd) > 300 ? p.aim : perp;
      tx = p.x + Math.cos(want) * 100; ty = p.y + Math.sin(want) * 100;
      // occasionally wall up when hurt
      if (p.hp < 55 && t > p.aiBuild) { p.buildReq = 1; p.aiBuild = t + 1600; }
      // reload if empty
      var wk = p.weapons[p.slot];
      if (wk && wk.mag === 0) p.reloadReq = true;
    } else {
      p.aim = Math.atan2(ty - p.y, tx - p.x);
    }
    var mvx = tx - p.x, mvy = ty - p.y, m = Math.hypot(mvx, mvy) || 1;
    p.ax = mvx / m; p.ay = mvy / m;
    p.sprint = outside;
    // auto pick up nearby loot
    p.pickupReq = true;
  }

  // ================================================================ SNAPSHOT
  function buildSnap() {
    var players = [];
    for (var id in sim.players) {
      var p = sim.players[id];
      var wk = p.weapons[p.slot] || { mag: 0, reserve: 0 };
      players.push({
        id: p.id, n: p.name, x: Math.round(p.x), y: Math.round(p.y), a: +p.aim.toFixed(2),
        hp: Math.round(p.hp), sh: Math.round(p.shield), al: p.alive, k: p.kills, df: p.dmgFlash,
        sl: p.slot, mag: wk.mag, res: wk.reserve, mats: p.mats, rl: p.reloading ? 1 : 0, bot: p.bot
      });
    }
    var bullets = [];
    for (var b = 0; b < sim.bullets.length; b++) {
      var bu = sim.bullets[b];
      bullets.push([Math.round(bu.x), Math.round(bu.y), bu.color]);
    }
    var walls = [];
    for (var w = 0; w < sim.walls.length; w++) {
      var wl = sim.walls[w]; walls.push([wl.x, wl.y, wl.hp, wl.ramp ? 1 : 0]);
    }
    var loot = [];
    for (var l = 0; l < world.loot.length; l++) {
      var it = world.loot[l]; if (it.taken) continue;
      loot.push([it.x, it.y, it.kind === "weapon" ? it.w : it.kind]);
    }
    var aliveN = players.filter(function (p) { return p.al; }).length;
    return {
      t: "snap", players: players, bullets: bullets, walls: walls, loot: loot,
      storm: { cx: Math.round(sim.storm.cx), cy: Math.round(sim.storm.cy), r: Math.round(sim.storm.r), ph: sim.storm.phase, tm: Math.round(sim.storm.timer) },
      feed: sim.feed.map(function (f) { return f.txt; }).slice(-4),
      alive: aliveN, over: sim.over, winner: sim.winnerId || null
    };
  }

  function applySnap(s) {
    prevSnap = lastSnap; lastSnap = s; snapTime = now();
    render.players = {};
    for (var i = 0; i < s.players.length; i++) { var p = s.players[i]; render.players[p.id] = p; }
    render.bullets = s.bullets; render.walls = s.walls; render.loot = s.loot;
    render.storm = { cx: s.storm.cx, cy: s.storm.cy, r: s.storm.r, phase: s.storm.ph, timer: s.storm.tm };
    render.alive = s.alive; render.started = true; render.feed = s.feed;
    // reconcile own prediction if it drifts too far
    var me = render.players[myId];
    if (me) {
      if (!predict.has || dist2(predict.x, predict.y, me.x, me.y) > 70 * 70) {
        predict.x = me.x; predict.y = me.y; predict.has = true;
      }
    }
    if (s.over) endMatch(s);
  }

  // ================================================================ INPUT
  window.addEventListener("keydown", function (e) {
    keys[e.key.toLowerCase()] = true;
    if (!render.started) return;
    var k = e.key.toLowerCase();
    if (k === "q") input.build = 1;
    if (k === "f") input.build = 2;
    if (k === "r") input.reload = true;
    if (k === "e") input.pickup = true;
    if (k === "1") input.swap = -99; // handled as absolute below
    if (k === "2") input.swap = 99;
    if (k === "shift") input.sprint = true;
  });
  window.addEventListener("keyup", function (e) {
    keys[e.key.toLowerCase()] = false;
    if (e.key.toLowerCase() === "shift") input.sprint = false;
  });
  canvas.addEventListener("mousemove", function (e) { mouse.x = e.clientX; mouse.y = e.clientY; });
  canvas.addEventListener("mousedown", function () { mouse.down = true; });
  window.addEventListener("mouseup", function () { mouse.down = false; });
  canvas.addEventListener("contextmenu", function (e) { e.preventDefault(); });

  function sampleInput() {
    var ax = 0, ay = 0;
    if (keys["w"]) ay -= 1; if (keys["s"]) ay += 1;
    if (keys["a"]) ax -= 1; if (keys["d"]) ax += 1;
    input.ax = ax; input.ay = ay;
    // aim: world angle from my rendered position to the mouse
    var me = render.players[myId];
    var mx = me ? me.x : cam.x, my = me ? me.y : cam.y;
    var wx = cam.x + (mouse.x - W / 2), wy = cam.y + (mouse.y - H / 2);
    input.aim = Math.atan2(wy - my, wx - mx);
    input.shoot = mouse.down;
    input.sprint = !!keys["shift"];
    setupTouch();
  }

  // ================================================================ HOST/CLIENT WIRING
  function applyInputToPlayer(p, inp) {
    p.ax = inp.ax; p.ay = inp.ay; p.aim = inp.aim; p.shoot = inp.shoot; p.sprint = inp.sprint;
    if (inp.build) p.buildReq = inp.build;
    if (inp.reload) p.reloadReq = true;
    if (inp.pickup) p.pickupReq = true;
    if (inp.swap === -99) { p.slot = p.slots[0]; }
    else if (inp.swap === 99) { p.slot = p.slots[Math.min(1, p.slots.length - 1)]; }
    else if (inp.swap) p.swapReq = inp.swap;
  }

  // host receives client input
  net.onData = function (msg, from) {
    if (msg.t === "join") {
      clientNames[from] = (msg.name || "Player").slice(0, 12);
      refreshLobby();
      if (sim && sim.started && !sim.players[from]) {
        sim.players[from] = makePlayer(from, clientNames[from], false);
      }
      net.sendTo(from, { t: "welcome", seed: seed, you: from, started: !!(sim && sim.started) });
    } else if (msg.t === "input" && sim && sim.players[from]) {
      applyInputToPlayer(sim.players[from], msg);
    }
  };
  net.onPeerJoin = function (id) { refreshLobby(); };
  net.onPeerLeave = function (id) {
    delete clientNames[id];
    if (sim && sim.players[id]) sim.players[id].alive = false; // treat as eliminated
    refreshLobby();
  };

  // client receives from host
  net.onHostData = function (msg) {
    if (msg.t === "welcome") {
      seed = msg.seed; myId = msg.you;
      var w = rebuildDeterministic(seed); world.obstacles = w.obstacles;
      if (msg.started) { show("game"); render.started = true; loopStart(); }
    } else if (msg.t === "snap") {
      applySnap(msg);
    } else if (msg.t === "start") {
      show("game"); render.started = true; loopStart();
    }
  };
  net.onConnected = function () {
    status("Connected! Waiting for host to start…");
    net.sendToHost({ t: "join", name: myName });
  };
  net.onError = function (m) { status(m, true); };

  // ================================================================ LOOP
  var running = false, lastT = 0, acc = 0, sendAcc = 0;
  function loopStart() { if (running) return; running = true; lastT = now(); requestAnimationFrame(loop); }

  function loop() {
    if (!running) return;
    var t = now(), dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
    sampleInput();

    if (role === "host") {
      // drive my own player
      if (sim && sim.players[myId]) applyInputToPlayer(sim.players[myId], input);
      // fixed-step sim
      acc += dt;
      while (acc >= SIM_DT) { simStep(SIM_DT); acc -= SIM_DT; }
      // broadcast snapshots
      sendAcc += dt;
      if (sendAcc >= 1 / SNAP_HZ) {
        sendAcc = 0;
        var snap = buildSnap();
        net.broadcast(snap);
        applySnap(snap); // host renders from same snapshot
      }
    } else {
      // client: predict own movement + send input
      clientPredict(dt);
      sendAcc += dt;
      if (sendAcc >= 1 / SNAP_HZ) { sendAcc = 0; sendInput(); }
    }
    // reset one-shot inputs after they're consumed/sent
    input.build = 0; input.reload = false; input.pickup = false; input.swap = 0;

    drawFrame();
    requestAnimationFrame(loop);
  }

  function sendInput() {
    net.sendToHost({ t: "input", ax: input.ax, ay: input.ay, aim: input.aim,
      shoot: input.shoot, build: input.build, reload: input.reload,
      pickup: input.pickup, swap: input.swap, sprint: input.sprint });
  }

  // client-side movement prediction for the local player only
  function clientPredict(dt) {
    var me = render.players[myId];
    if (!me || !me.al) { predict.has = false; return; }
    if (!predict.has) { predict.x = me.x; predict.y = me.y; predict.has = true; }
    var sp = input.sprint ? 285 : 205;
    var mag = Math.hypot(input.ax, input.ay);
    if (mag > 0.01) { predict.x += (input.ax / mag) * sp * dt; predict.y += (input.ay / mag) * sp * dt; }
    // light collision vs walls/obstacles using render state
    predict.x = clamp(predict.x, PLR_R, MAP - PLR_R);
    predict.y = clamp(predict.y, PLR_R, MAP - PLR_R);
    for (var i = 0; i < world.obstacles.length; i++) {
      var o = world.obstacles[i], rr = o.r + PLR_R;
      var dx = predict.x - o.x, dy = predict.y - o.y, d2 = dx * dx + dy * dy;
      if (d2 < rr * rr && d2 > 0.01) { var d = Math.sqrt(d2); predict.x += dx / d * (rr - d); predict.y += dy / d * (rr - d); }
    }
  }

  // ================================================================ RENDER
  function drawFrame() {
    // camera follows my predicted position (client) or authoritative (host)
    var me = render.players[myId];
    var mx, my;
    if (role === "client" && predict.has) { mx = predict.x; my = predict.y; }
    else if (me) { mx = me.x; my = me.y; }
    else { mx = cam.x; my = cam.y; }
    cam.x += (mx - cam.x) * 0.2; cam.y += (my - cam.y) * 0.2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.save();
    ctx.translate(W / 2 - cam.x, H / 2 - cam.y);

    drawGround();
    // loot
    for (var i = 0; i < render.loot.length; i++) drawLoot(render.loot[i]);
    // obstacles
    for (var o = 0; o < world.obstacles.length; o++) drawObstacle(world.obstacles[o]);
    // walls
    for (var w = 0; w < render.walls.length; w++) drawWall(render.walls[w]);
    // players
    for (var id in render.players) drawPlayer(render.players[id], id === myId);
    // bullets
    ctx.lineWidth = 2;
    for (var b = 0; b < render.bullets.length; b++) {
      var bu = render.bullets[b];
      ctx.fillStyle = bu[2] || "#fff";
      ctx.beginPath(); ctx.arc(bu[0], bu[1], 3, 0, 7); ctx.fill();
    }
    drawStorm();
    ctx.restore();

    drawHUD();
    drawMini();
  }

  function drawGround() {
    ctx.fillStyle = "#245c3a";
    ctx.fillRect(0, 0, MAP, MAP);
    ctx.strokeStyle = "rgba(255,255,255,.04)"; ctx.lineWidth = 1;
    for (var x = 0; x <= MAP; x += CELL * 2) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, MAP); ctx.stroke(); }
    for (var y = 0; y <= MAP; y += CELL * 2) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(MAP, y); ctx.stroke(); }
    // border
    ctx.strokeStyle = "#13331f"; ctx.lineWidth = 8; ctx.strokeRect(0, 0, MAP, MAP);
  }
  function drawObstacle(o) {
    if (o.type === "rock") { ctx.fillStyle = "#6b7280"; }
    else { ctx.fillStyle = "#1f6b3a"; }
    ctx.beginPath(); ctx.arc(o.x, o.y, o.r, 0, 7); ctx.fill();
    if (o.type === "tree") { ctx.fillStyle = "#2f8f4f"; ctx.beginPath(); ctx.arc(o.x, o.y, o.r * 0.6, 0, 7); ctx.fill(); }
  }
  function drawWall(w) {
    var h = CELL / 2, hp = w[2] / 120;
    ctx.fillStyle = w[3] ? "rgba(180,140,90,.55)" : "#a9743f";
    ctx.fillRect(w[0] - h, w[1] - h, CELL, CELL);
    ctx.strokeStyle = "rgba(0,0,0,.3)"; ctx.strokeRect(w[0] - h, w[1] - h, CELL, CELL);
    // hp tint
    ctx.fillStyle = "rgba(0,0,0," + (0.35 * (1 - hp)) + ")";
    ctx.fillRect(w[0] - h, w[1] - h, CELL, CELL);
  }
  function drawLoot(it) {
    var kind = it[2];
    ctx.save(); ctx.translate(it[0], it[1]);
    var pulse = 1 + Math.sin(now() / 300) * 0.1;
    ctx.scale(pulse, pulse);
    if (kind === "shield") ctx.fillStyle = "#4aa3ff";
    else if (kind === "mats") ctx.fillStyle = "#c9a06b";
    else ctx.fillStyle = (WEAPONS[kind] && WEAPONS[kind].color) || "#ffd24a";
    ctx.beginPath(); ctx.arc(0, 0, 9, 0, 7); ctx.fill();
    ctx.fillStyle = "rgba(0,0,0,.6)"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(kind === "shield" ? "S" : kind === "mats" ? "▦" : (WEAPONS[kind] ? WEAPONS[kind].name[0] : "?"), 0, 3);
    ctx.restore();
  }
  function drawPlayer(p, isMe) {
    if (!p.al) return;
    var x = p.x, y = p.y;
    if (isMe && role === "client" && predict.has) { x = predict.x; y = predict.y; }
    ctx.save(); ctx.translate(x, y);
    // gun
    ctx.strokeStyle = "#222"; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(p.a) * 26, Math.sin(p.a) * 26); ctx.stroke();
    // body
    ctx.fillStyle = p.df > 0 ? "#fff" : (isMe ? "#ffd24a" : (p.bot ? "#9aa3b5" : "#ff7a59"));
    ctx.beginPath(); ctx.arc(0, 0, PLR_R, 0, 7); ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,.4)"; ctx.lineWidth = 2; ctx.stroke();
    ctx.restore();
    // name + hp bar
    ctx.fillStyle = "#fff"; ctx.font = "11px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(p.n, x, y - 26);
    var bw = 34;
    ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(x - bw / 2, y - 23, bw, 4);
    ctx.fillStyle = "#39d98a"; ctx.fillRect(x - bw / 2, y - 23, bw * (p.hp / 100), 4);
    if (p.sh > 0) { ctx.fillStyle = "#4aa3ff"; ctx.fillRect(x - bw / 2, y - 27, bw * (p.sh / 100), 3); }
  }
  function drawStorm() {
    var st = render.storm;
    ctx.save();
    // darken everything, then punch a hole for the safe zone
    ctx.fillStyle = "rgba(120,60,200,.28)";
    ctx.beginPath();
    ctx.rect(0, 0, MAP, MAP);
    ctx.arc(st.cx, st.cy, st.r, 0, 7, true);
    ctx.fill("evenodd");
    ctx.strokeStyle = "#b388ff"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(st.cx, st.cy, st.r, 0, 7); ctx.stroke();
    ctx.restore();
  }

  // ---- HUD ----
  var feedEl = $("killfeed");
  function drawHUD() {
    var me = render.players[myId];
    if (!me) return;
    $("aliveCount").textContent = render.alive;
    $("killCount").textContent = me.k;
    $("matCount").textContent = me.mats;
    $("healthText").textContent = me.hp; $("shieldText").textContent = me.sh;
    $("healthFill").style.transform = "scaleX(" + (me.hp / 100) + ")";
    $("shieldFill").style.transform = "scaleX(" + (me.sh / 100) + ")";
    var W2 = WEAPONS[me.sl];
    $("weaponName").textContent = (W2 ? W2.name : "—") + (me.rl ? " (reloading…)" : "");
    $("ammo").textContent = me.mag + " / " + me.res;
    $("stormInfo").textContent = render.storm.phase >= STORM_DPS.length ? "Final storm!" : "Storm closes in " + render.storm.timer + "s";
    // kill feed
    var feed = render.feed || [];
    feedEl.innerHTML = feed.map(function (f) { return "<div>" + esc(f) + "</div>"; }).join("");
  }
  function esc(s) { return String(s).replace(/[&<>]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]; }); }

  function drawMini() {
    var s = 160 / MAP;
    mctx.clearRect(0, 0, 160, 160);
    mctx.fillStyle = "#15402a"; mctx.fillRect(0, 0, 160, 160);
    // storm
    var st = render.storm;
    mctx.strokeStyle = "#b388ff"; mctx.lineWidth = 2;
    mctx.beginPath(); mctx.arc(st.cx * s, st.cy * s, st.r * s, 0, 7); mctx.stroke();
    // players
    for (var id in render.players) {
      var p = render.players[id]; if (!p.al) continue;
      mctx.fillStyle = id === myId ? "#ffd24a" : (p.bot ? "#9aa3b5" : "#ff7a59");
      mctx.beginPath(); mctx.arc(p.x * s, p.y * s, id === myId ? 3.2 : 2.2, 0, 7); mctx.fill();
    }
  }

  // ================================================================ MATCH FLOW
  function status(m, err) { var s = $("status"); s.textContent = m || ""; s.className = "status" + (err ? " err" : ""); }

  function refreshLobby() {
    var list = $("playerList");
    var items = ['<li><span>' + esc(myName) + ' (you · host)</span><span class="dot">●</span></li>'];
    for (var id in clientNames) items.push('<li><span>' + esc(clientNames[id]) + '</span><span class="dot">●</span></li>');
    list.innerHTML = items.join("");
  }

  var ended = false;
  function endMatch(s) {
    if (ended) return; ended = true; running = false;
    var me = render.players[myId];
    var win = s.winner === myId;
    $("overTitle").textContent = win ? "👑 Victory Royale!" : "Match over";
    var place = win ? 1 : render.alive + (me && me.al ? 0 : 1);
    $("overStats").textContent = (me ? ("Eliminations: " + me.k + " · ") : "") +
      (win ? "You outlasted everyone." : "Better luck next drop.");
    setTimeout(function () { show("over"); }, 900);
  }

  // ================================================================ BUTTONS
  $("nameInput").value = localStorage.getItem("br_name") || "";
  function readName() { myName = ($("nameInput").value || "Player").slice(0, 12) || "Player"; localStorage.setItem("br_name", myName); }

  $("hostBtn").onclick = function () {
    readName(); role = "host"; myId = "HOST"; status("Creating room…");
    seed = (Math.random() * 1e9) | 0;
    var w = rebuildDeterministic(seed); world.obstacles = w.obstacles;
    net.host();
    net.onReady = function (code) {
      $("roomCode").textContent = code; refreshLobby(); show("lobby");
    };
  };

  $("joinBtn").onclick = function () {
    readName(); role = "client";
    var code = ($("codeInput").value || "").toUpperCase().trim();
    if (code.length < 4) { status("Enter the room code first.", true); return; }
    status("Connecting to " + code + "…");
    net.join(code);
  };

  $("soloBtn").onclick = function () {
    readName(); role = "host"; myId = "HOST";
    seed = (Math.random() * 1e9) | 0;
    var w = rebuildDeterministic(seed); world.obstacles = w.obstacles;
    // Solo is purely local — no networking, so it works even offline / if the
    // PeerJS CDN is unreachable.
    startSim(); ended = false; show("game"); loopStart();
  };

  $("startBtn").onclick = function () {
    startSim(); ended = false;
    net.broadcast({ t: "start" });
    show("game"); loopStart();
  };

  $("againBtn").onclick = function () { location.reload(); };

  // ================================================================ TOUCH (basic)
  var touchSetup = false;
  function setupTouch() {
    if (touchSetup) return; touchSetup = true;
    if (!("ontouchstart" in window)) return;
    $("touch").classList.remove("hidden");
    bindStick($("stickMove"), function (dx, dy) { input.ax = dx; input.ay = dy; });
    bindStick($("stickAim"), function (dx, dy, mag) {
      if (mag > 0.2) { input.aim = Math.atan2(dy, dx); mouse.down = true; } else mouse.down = false;
    });
    document.querySelectorAll(".tbtn").forEach(function (b) {
      b.addEventListener("touchstart", function (e) {
        e.preventDefault();
        if (b.dataset.act === "build") input.build = 1;
        if (b.dataset.act === "reload") input.reload = true;
      });
    });
  }
  function bindStick(el, cb) {
    var cx, cy, active = false;
    var knob = el.querySelector(".knob");
    el.addEventListener("touchstart", function (e) {
      e.preventDefault(); active = true;
      var r = el.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2;
    });
    el.addEventListener("touchmove", function (e) {
      if (!active) return; e.preventDefault();
      var t = e.touches[0], dx = t.clientX - cx, dy = t.clientY - cy;
      var mag = Math.min(1, Math.hypot(dx, dy) / 55), ang = Math.atan2(dy, dx);
      knob.style.transform = "translate(" + Math.cos(ang) * mag * 35 + "px," + Math.sin(ang) * mag * 35 + "px)";
      cb(Math.cos(ang) * mag, Math.sin(ang) * mag, mag);
    });
    function end(e) { active = false; knob.style.transform = ""; cb(0, 0, 0); }
    el.addEventListener("touchend", end); el.addEventListener("touchcancel", end);
  }

  status("");
})();
