import { DurableObject } from "cloudflare:workers";

const W = 8;
const H = 12;
const GOAL = 20;
const MATCH_MS = 600000;
const BLUE = 1;
const RED = 2;
const SPAWN_ORDER = [3, 4, 2, 5, 1, 6, 0, 7];

function emptyBoard() {
  return Array.from({ length: H }, () => Array(W).fill(0));
}

function other(p) {
  return p === BLUE ? RED : BLUE;
}

function neighbors(x, y) {
  return [[x-1,y],[x+1,y],[x,y-1],[x,y+1]]
    .filter(([a,b]) => a >= 0 && a < W && b >= 0 && b < H);
}

function groupsOf(board) {
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const groups = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!board[y][x] || seen[y][x]) continue;

      const color = board[y][x];
      const stack = [[x,y]];
      const stones = [];
      const liberties = new Set();
      seen[y][x] = true;

      while (stack.length) {
        const [a,b] = stack.pop();
        stones.push([a,b]);

        for (const [nx,ny] of neighbors(a,b)) {
          if (!board[ny][nx]) liberties.add(ny * W + nx);
          else if (board[ny][nx] === color && !seen[ny][nx]) {
            seen[ny][nx] = true;
            stack.push([nx,ny]);
          }
        }
      }

      groups.push({ color, stones, liberties: liberties.size });
    }
  }

  return groups;
}

function settle(board) {
  const captured = [0,0,0];
  let changed = true;
  let loops = 0;

  while (changed && loops++ < W * H) {
    changed = false;
    const remove = [];

    for (const group of groupsOf(board)) {
      if (group.liberties === 0) {
        remove.push(...group.stones.map(([x,y]) => [x,y,group.color]));
      }
    }

    if (remove.length) {
      changed = true;
      for (const [x,y,color] of remove) {
        if (board[y][x] === color) {
          board[y][x] = 0;
          captured[color]++;
        }
      }
    }

    if (changed) {
      for (let x = 0; x < W; x++) {
        const stack = [];
        for (let y = H - 1; y >= 0; y--) {
          if (board[y][x]) stack.push(board[y][x]);
        }
        for (let y = H - 1; y >= 0; y--) {
          board[y][x] = stack[H - 1 - y] || 0;
        }
      }
    }
  }

  return captured;
}

function landingY(board, x) {
  if (board[0][x]) return -1;
  let y = 0;
  while (y + 1 < H && !board[y + 1][x]) y++;
  return y;
}

function place(board, x, y, player) {
  const next = board.map(row => row.slice());
  if (y < 0 || next[y][x]) return { ok: false };

  next[y][x] = player;
  const captured = settle(next);
  const ownGroups = groupsOf(next).filter(g => g.color === player);

  if (ownGroups.some(g => g.liberties === 0)) {
    return { ok: false, suicide: true };
  }

  return { ok: true, board: next, captured };
}

function finish(state, winner, reason) {
  state.gameOver = true;
  state.winner = winner;
  state.reason = reason;
}

function checkTimeout(state) {
  if (state.gameOver) return;

  if (Date.now() - state.startedAt >= MATCH_MS) {
    if (state.scores[BLUE] > state.scores[RED]) {
      finish(state, BLUE, "Tiempo agotado.");
    } else if (state.scores[RED] > state.scores[BLUE]) {
      finish(state, RED, "Tiempo agotado.");
    } else {
      state.suddenDeath = true;
    }
  }
}

function publicState(state, message = "") {
  checkTimeout(state);
  return {
    type: "state",
    board: state.board,
    scores: state.scores,
    player: state.player,
    remaining: Math.max(0, MATCH_MS - (Date.now() - state.startedAt)) / 1000,
    suddenDeath: state.suddenDeath,
    gameOver: state.gameOver,
    winner: state.winner,
    reason: state.reason,
    message
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "gravity-go-online",
        matchmaking: true
      });
    }

    if (url.pathname === "/ws") {
      const id = env.GAME_HUB.idFromName("global-matchmaking");
      return env.GAME_HUB.get(id).fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
  }

  send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  async broadcast(matchId, data) {
    for (const socket of this.ctx.getWebSockets()) {
      const info = socket.deserializeAttachment() || {};
      if (info.matchId === matchId) this.send(socket, data);
    }
  }

  async getGame(matchId) {
    return await this.ctx.storage.get("game:" + matchId);
  }

  async saveAndBroadcast(matchId, state, message = "") {
    await this.ctx.storage.put("game:" + matchId, state);
    await this.broadcast(matchId, publicState(state, message));
  }

  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("WebSocket required", { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    server.serializeAttachment({
      playerId: crypto.randomUUID(),
      status: "connected"
    });

    this.ctx.acceptWebSocket(server);

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(socket, message) {
    this.handleMessage(socket, message).catch(error => {
      console.error("[WS] Error procesando mensaje:", error);
      this.send(socket, {
        type: "error",
        message: "Error procesando el mensaje."
      });
    });
  }

  webSocketClose(socket) {
    this.handleDisconnect(socket).catch(error => {
      console.error("[WS] Error al cerrar conexión:", error);
    });
  }

  webSocketError(socket) {
    this.handleDisconnect(socket).catch(error => {
      console.error("[WS] Error de conexión:", error);
    });
  }

  async handleMessage(socket, raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(socket, { type: "error", message: "Mensaje no válido." });
      return;
    }

    const info = socket.deserializeAttachment() || {};

    console.log("[DEBUG] Mensaje recibido:", msg.type, "Estado:", info.status);

    if (msg.type === "piece_motion") {
      if (info.status !== "matched" || !info.matchId) return;

      const state = await this.getGame(info.matchId);
      const x = Number(msg.x);
      const y = Number(msg.y);

      if (
        !state || state.gameOver ||
        state.player !== info.color ||
        !Number.isInteger(x) || !Number.isInteger(y) ||
        x < 0 || x >= W || y < 0 || y >= H ||
        state.board[y][x] !== 0 ||
        landingY(state.board, x) < y
      ) return;

      await this.broadcast(info.matchId, {
        type: "piece_motion",
        color: info.color,
        x,
        y
      });
      return;
    }

    if (msg.type === "ping") {
      if (info.status === "matched" && info.matchId) {
        const state = await this.getGame(info.matchId);
        if (state) {
          checkTimeout(state);
          await this.saveAndBroadcast(info.matchId, state);
        }
      } else {
        this.send(socket, { type: "pong" });
      }
      return;
    }

    if (msg.type === "find") {
      if (info.status === "matched") {
        this.send(socket, { type: "already_matched" });
        return;
      }

      if (info.status === "queued") {
        this.send(socket, { type: "searching" });
        return;
      }

      const waiting = this.ctx.getWebSockets().find(candidate => {
        if (candidate === socket || candidate.readyState !== WebSocket.OPEN) return false;
        const candidateInfo = candidate.deserializeAttachment() || {};
        return candidateInfo.status === "queued";
      });

      if (!waiting) {
        info.status = "queued";
        socket.serializeAttachment(info);
        this.send(socket, { type: "searching" });
        return;
      }

      const waitingInfo = waiting.deserializeAttachment() || {};
      const matchId = crypto.randomUUID();

      waitingInfo.status = "matched";
      waitingInfo.matchId = matchId;
      waitingInfo.color = BLUE;
      waiting.serializeAttachment(waitingInfo);

      info.status = "matched";
      info.matchId = matchId;
      info.color = RED;
      socket.serializeAttachment(info);

      const state = {
        board: emptyBoard(),
        scores: [0,0,0],
        player: BLUE,
        startedAt: Date.now(),
        suddenDeath: false,
        gameOver: false,
        winner: null,
        reason: ""
      };

      await this.ctx.storage.put("game:" + matchId, state);

      this.send(waiting, {
        type: "match_found",
        matchId,
        color: BLUE,
        opponentColor: RED
      });

      this.send(socket, {
        type: "match_found",
        matchId,
        color: RED,
        opponentColor: BLUE
      });

      await this.broadcast(matchId, publicState(state, "¡Partida encontrada!"));
      return;
    }

    if (msg.type === "cancel_search") {
      if (info.status === "queued") {
        info.status = "connected";
        socket.serializeAttachment(info);
        this.send(socket, { type: "search_cancelled" });
      }
      return;
    }

    if (msg.type === "move") {
      if (info.status !== "matched" || !info.matchId) return;

      const state = await this.getGame(info.matchId);
      if (!state || state.gameOver) return;

      checkTimeout(state);
      if (state.gameOver) {
        await this.saveAndBroadcast(info.matchId, state);
        return;
      }

      if (state.player !== info.color) {
        this.send(socket, { type: "error", message: "No es tu turno." });
        return;
      }

      const x = Number(msg.x);
      if (!Number.isInteger(x) || x < 0 || x >= W) {
        this.send(socket, { type: "error", message: "Columna no válida." });
        return;
      }

      const y = landingY(state.board, x);
      if (y < 0) {
        state.player = other(state.player);
        await this.saveAndBroadcast(info.matchId, state, "Columna llena. Turno perdido.");
        return;
      }

      const result = place(state.board, x, y, state.player);
      const mover = state.player;

      if (!result.ok) {
        state.player = other(mover);
        await this.saveAndBroadcast(
          info.matchId,
          state,
          result.suicide ? "Suicidio prohibido. Turno perdido." : "Jugada no válida. Turno perdido."
        );
        return;
      }

      state.board = result.board;
      const gained = result.captured[other(mover)] || 0;
      state.scores[mover] += gained;

      if (state.scores[mover] >= GOAL) {
        finish(state, mover, "¡" + (mover === BLUE ? "Azul" : "Rojo") + " alcanza las 20 capturas!");
      } else if (state.suddenDeath && gained > 0) {
        finish(state, mover, "¡Captura decisiva en muerte súbita!");
      } else if (!SPAWN_ORDER.some(col => !state.board[0][col])) {
        if (state.scores[BLUE] > state.scores[RED]) finish(state, BLUE, "Tablero bloqueado.");
        else if (state.scores[RED] > state.scores[BLUE]) finish(state, RED, "Tablero bloqueado.");
        else finish(state, 0, "Tablero bloqueado. Empate.");
      }

      if (!state.gameOver) state.player = other(mover);

      const message = gained
        ? (mover === BLUE ? "Azul" : "Rojo") + " captura " + gained + " cubo(s)."
        : "Cubo colocado. Sin capturas.";

      await this.saveAndBroadcast(info.matchId, state, message);
    }
  }

  async handleDisconnect(socket) {
    const info = socket.deserializeAttachment() || {};

    if (info.status === "queued") {
      info.status = "disconnected";
      socket.serializeAttachment(info);
      return;
    }

    if (info.status === "matched" && info.matchId) {
      await this.broadcast(info.matchId, {
        type: "opponent_disconnected",
        message: "El rival se ha desconectado."
      });
    }
  }
}
