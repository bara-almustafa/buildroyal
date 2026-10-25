/* net.js — peer-to-peer transport over WebRTC using PeerJS.
 *
 * Topology: host-authoritative star.
 *   - The host owns the game simulation. Its PeerJS id IS the room code.
 *   - Each client opens one DataConnection to the host.
 *   - Clients send {input} up; the host broadcasts {state} snapshots down.
 *
 * This file knows nothing about gameplay — it only moves JSON messages and
 * reports connect/disconnect/data via callbacks the game layer sets.
 */
(function (global) {
  "use strict";

  // Room codes are the host's PeerJS id. Prefix keeps us off other apps'
  // ids on the shared public broker.
  var PREFIX = "buildroyale-";
  var ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

  function makeCode() {
    var s = "";
    for (var i = 0; i < 6; i++) s += ALPHABET[(Math.random() * ALPHABET.length) | 0];
    return s;
  }

  function Net() {
    this.peer = null;
    this.isHost = false;
    this.code = null;
    this.conns = {}; // host: peerId -> DataConnection
    this.hostConn = null; // client: connection to host
    // callbacks (set by game)
    this.onReady = function () {};       // (code)
    this.onPeerJoin = function () {};    // (peerId)   host only
    this.onPeerLeave = function () {};   // (peerId)   host only
    this.onData = function () {};        // (msg, fromPeerId)
    this.onHostData = function () {};    // (msg)      client only
    this.onError = function () {};       // (message)
    this.onConnected = function () {};   // ()         client: joined host
  }

  function newPeer(id) {
    // No config => PeerJS default public cloud broker + Google STUN.
    return id ? new Peer(id) : new Peer();
  }

  function peerMissing(self) {
    if (typeof Peer === "undefined") {
      self.onError("Multiplayer library didn't load (no internet?). Solo mode still works.");
      return true;
    }
    return false;
  }

  // ---- HOST ----
  Net.prototype.host = function () {
    var self = this;
    if (peerMissing(self)) return;
    this.isHost = true;
    this.code = makeCode();
    this.peer = newPeer(PREFIX + this.code);

    this.peer.on("open", function () { self.onReady(self.code); });
    this.peer.on("error", function (e) {
      // Code collision on broker: pick a new one and retry once.
      if (e && e.type === "unavailable-id") {
        self.code = makeCode();
        self.peer = newPeer(PREFIX + self.code);
        self.peer.on("open", function () { self.onReady(self.code); });
        self.peer.on("connection", bindConn);
        self.peer.on("error", function (e2) { self.onError(humanErr(e2)); });
        return;
      }
      self.onError(humanErr(e));
    });

    this.peer.on("connection", bindConn);

    function bindConn(conn) {
      conn.on("open", function () {
        self.conns[conn.peer] = conn;
        self.onPeerJoin(conn.peer);
      });
      conn.on("data", function (msg) { self.onData(msg, conn.peer); });
      conn.on("close", function () {
        delete self.conns[conn.peer];
        self.onPeerLeave(conn.peer);
      });
      conn.on("error", function () {
        delete self.conns[conn.peer];
        self.onPeerLeave(conn.peer);
      });
    }
  };

  // ---- CLIENT ----
  Net.prototype.join = function (code) {
    var self = this;
    if (peerMissing(self)) return;
    this.isHost = false;
    this.code = String(code || "").toUpperCase().trim();
    this.peer = newPeer();

    this.peer.on("open", function () {
      var conn = self.peer.connect(PREFIX + self.code, { reliable: true });
      self.hostConn = conn;

      var connected = false;
      conn.on("open", function () {
        connected = true;
        self.onConnected();
      });
      conn.on("data", function (msg) { self.onHostData(msg); });
      conn.on("close", function () { self.onError("Disconnected from host."); });
      conn.on("error", function () { self.onError("Could not reach that room."); });

      // Fail fast if the host never answers (bad/stale code).
      setTimeout(function () {
        if (!connected) self.onError("No response — check the room code.");
      }, 9000);
    });

    this.peer.on("error", function (e) { self.onError(humanErr(e)); });
  };

  // ---- messaging ----
  // Host -> every client.
  Net.prototype.broadcast = function (msg) {
    for (var id in this.conns) {
      var c = this.conns[id];
      if (c && c.open) { try { c.send(msg); } catch (e) {} }
    }
  };
  // Host -> one client.
  Net.prototype.sendTo = function (peerId, msg) {
    var c = this.conns[peerId];
    if (c && c.open) { try { c.send(msg); } catch (e) {} }
  };
  // Client -> host.
  Net.prototype.sendToHost = function (msg) {
    if (this.hostConn && this.hostConn.open) {
      try { this.hostConn.send(msg); } catch (e) {}
    }
  };

  Net.prototype.destroy = function () {
    try { if (this.peer) this.peer.destroy(); } catch (e) {}
    this.peer = null; this.conns = {}; this.hostConn = null;
  };

  function humanErr(e) {
    var t = (e && e.type) || "";
    if (t === "peer-unavailable") return "Room not found — double-check the code.";
    if (t === "network") return "Network problem reaching the matchmaking broker.";
    if (t === "browser-incompatible") return "This browser can't do WebRTC.";
    if (t === "unavailable-id") return "Room code taken, retrying…";
    return "Connection error" + (t ? " (" + t + ")" : "") + ".";
  }

  global.Net = Net;
})(window);
