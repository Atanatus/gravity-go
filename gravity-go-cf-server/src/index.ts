
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

function other(player) {
  return player === BLUE ? RED : BLUE;
}

function colorName(player) {
  return player === BLUE ? "Azul" : "Rojo";
}

function neighbors(x, y) {
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]]
    .filter(([a, b]) => a >= 0 && a < W && b >= 0 && b < H);
}

function groupsOf(board) {
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const groups = [];

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!board[y][x] || seen[y][x]) continue;

      const color = board[y][x];
      const stack = [[x, y]];
      const stones = [];
      const liberties = new Set();
      seen[y][x] = true;

      while (stack.length) {
        const [a, b] = stack.pop();
        stones.push([a, b]);

        for (const [nx, ny] of neighbors(a, b)) {
          if (!board[ny][nx]) {
            liberties.add(ny * W + nx);
          } else if (board[ny][nx] === color && !seen[ny][nx]) {
            seen[ny][nx] = true;
            stack.push([nx, ny]);
          }
        }
      }

      groups.push({
        color,
        stones,
        liberties: liberties.size
      });
    }
  }

  return groups;
}

function settle(board) {
  const captured = [0, 0, 0];
  let changed = true;
  let loops = 0;

  while (changed && loops++ < W * H) {
    changed = false;
    const remove = [];

    for (const group of groupsOf(board)) {
      if (group.liberties === 0) {
        remove.push(
          ...group.stones.map(([x, y]) => [x, y, group.color])
        );
      }
    }

    if (remove.length) {
      changed = true;

      for (const [x, y, color] of remove) {
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

function place(board, x, y, player) {
  if (
    !Number.isInteger(x) ||
    !Number.isInteger(y) ||
    x < 0 || x >= W ||
    y < 0 || y >= H ||
    board[y][x] !== 0
  ) {
    return { ok: false };
  }

  const next = board.map(row => row.slice());
  next[y][x] = player;

  const captured = settle(next);
  const ownGroups = groupsOf(next).filter(g => g.color === player);

  if (ownGroups.some(g => g.liberties === 0)) {
    return { ok: false, suicide: true };
  }

  return { ok: true, board: next, captured };
}

function finish(state, winner, reason) {
  if (state.gameOver) return;

  state.gameOver = true;
  state.phase = "over";
  state.winner = winner;
  state.reason = reason;
  state.activePiece = null;
  state.fastDrop = false;
}

function checkTimeout(state) {
  if (
    state.gameOver ||
    state.phase !== "playing" ||
    state.suddenDeath ||
    !state.startedAt
  ) {
    return;
  }

  if (Date.now() - state.startedAt < MATCH_MS) return;

  if (state.scores[BLUE] > state.scores[RED]) {
    finish(state, BLUE, "Tiempo agotado.");
  } else if (state.scores[RED] > state.scores[BLUE]) {
    finish(state, RED, "Tiempo agotado.");
  } else {
    state.suddenDeath = true;
  }
}

function publicState(state, message = "") {
  const remaining = state.phase !== "playing" || !state.startedAt
    ? (state.phase === "over" ? 0 : MATCH_MS / 1000)
    : Math.max(
        0,
        MATCH_MS - (Date.now() - state.startedAt)
      ) / 1000;

  return {
    type: "state",
    phase: state.phase,
    board: state.board,
    scores: state.scores,
    player: state.player,
    remaining,
    suddenDeath: state.suddenDeath,
    gameOver: state.gameOver,
    winner: state.winner,
    reason: state.reason,
    activePiece: state.activePiece || null,
    diceRolls: state.diceRolls,
    diceRound: state.diceRound,
    openingPlayer: state.openingPlayer,
    setupPlaced: state.setupPlaced,
    setupColumns: state.setupColumns,
    setupPlayer: state.setupPlayer,
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
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("WebSocket required", { status: 426 });
      }

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
    this.env = env;
  }

  send(socket, data) {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(data));
    }
  }

  async broadcast(matchId, data) {
    for (const socket of this.ctx.getWebSockets()) {
      const info = socket.deserializeAttachment() || {};

      if (info.matchId === matchId) {
        this.send(socket, data);
      }
    }
  }

  async getGame(matchId) {
    return await this.ctx.storage.get("game:" + matchId);
  }

  async saveAndBroadcast(matchId, state, message = "") {
    checkTimeout(state);

    await this.ctx.storage.put("game:" + matchId, state);
    await this.broadcast(matchId, publicState(state, message));

    if (!state.gameOver && state.phase === "playing") {
      await this.scheduleAlarm(state.fastDrop ? 45 : 250);
    }
  }

  async scheduleAlarm(delay = 250) {
    const when = Date.now() + delay;
    const current = await this.ctx.storage.getAlarm();

    if (current === null || when < current) {
      await this.ctx.storage.setAlarm(when);
    }
  }

  async spawnServerPiece(state) {
    for (const x of SPAWN_ORDER) {
      if (!state.board[0][x]) {
        state.activePiece = { x, y: 0 };
        state.fastDrop = false;
        state.fallAt = Date.now() + 480;
        return true;
      }
    }

    const winner =
      state.scores[BLUE] === state.scores[RED]
        ? 0
        : state.scores[BLUE] > state.scores[RED]
          ? BLUE
          : RED;

    finish(state, winner, "Tablero bloqueado.");
    return false;
  }

  async advanceGame(matchId, state, now = Date.now()) {
    if (state.gameOver || state.phase !== "playing") return;

    checkTimeout(state);

    if (state.gameOver) {
      await this.saveAndBroadcast(matchId, state, state.reason);
      return;
    }

    if (!state.activePiece) {
      await this.spawnServerPiece(state);
      await this.saveAndBroadcast(matchId, state);
      return;
    }

    if (now < state.fallAt) return;

    const p = state.activePiece;
    const nextY = p.y + 1;

    if (nextY < H && !state.board[nextY][p.x]) {
      p.y = nextY;
      state.fallAt = now + (state.fastDrop ? 45 : 480);

      await this.ctx.storage.put("game:" + matchId, state);
      await this.broadcast(matchId, {
        type: "piece_motion",
        color: state.player,
        x: p.x,
        y: p.y
      });

      return;
    }

    const mover = state.player;
    const result = place(state.board, p.x, p.y, mover);

    state.activePiece = null;
    state.fastDrop = false;

    if (!result.ok) {
      state.player = other(mover);

      await this.spawnServerPiece(state);
      await this.saveAndBroadcast(
        matchId,
        state,
        result.suicide
          ? "Suicidio prohibido. Turno perdido."
          : "Jugada no vÃ¡lida. Turno perdido."
      );

      return;
    }

    state.board = result.board;

    const gained = result.captured[other(mover)] || 0;
    state.scores[mover] += gained;

    if (state.scores[mover] >= GOAL) {
      finish(
        state,
        mover,
        "Â¡" + colorName(mover) + " alcanza las 20 capturas!"
      );
    } else if (state.suddenDeath && gained > 0) {
      finish(state, mover, "Â¡Captura decisiva en muerte sÃºbita!");
    } else if (!SPAWN_ORDER.some(col => !state.board[0][col])) {
      if (state.scores[BLUE] > state.scores[RED]) {
        finish(state, BLUE, "Tablero bloqueado.");
      } else if (state.scores[RED] > state.scores[BLUE]) {
        finish(state, RED, "Tablero bloqueado.");
      } else {
        finish(state, 0, "Tablero bloqueado. Empate.");
      }
    }

    if (!state.gameOver) {
      state.player = other(mover);
      await this.spawnServerPiece(state);
    }

    const message = gained
      ? colorName(mover) + " captura " + gained + " cubo(s)."
      : "Cubo colocado. Sin capturas.";

    await this.saveAndBroadcast(matchId, state, message);
  }

  async alarm() {
    const games = await this.ctx.storage.list({ prefix: "game:" });
    const now = Date.now();

    for (const [key, state] of games) {
      if (!state || state.gameOver || state.phase !== "playing") continue;

      await this.advanceGame(key.slice(5), state, now);
    }

    const current = await this.ctx.storage.list({ prefix: "game:" });
    const activeGames = [...current.values()].filter(
      state => state && !state.gameOver && state.phase === "playing"
    );

    if (activeGames.length) {
      await this.scheduleAlarm(
        activeGames.some(state => state.fastDrop) ? 45 : 250
      );
    }
  }

  async fetch(request) {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
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

    return new Response(null, {
      status: 101,
      webSocket: client
    });
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
      console.error("[WS] Error al cerrar conexiÃ³n:", error);
    });
  }

  webSocketError(socket) {
    this.handleDisconnect(socket).catch(error => {
      console.error("[WS] Error de conexiÃ³n:", error);
    });
  }

  async handleMessage(socket, raw) {
    let msg;

    try {
      msg = JSON.parse(raw);
    } catch {
      this.send(socket, {
        type: "error",
        message: "Mensaje no vÃ¡lido."
      });
      return;
    }

    const info = socket.deserializeAttachment() || {};

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
        if (
          candidate === socket ||
          candidate.readyState !== WebSocket.OPEN
        ) {
          return false;
        }

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

      const waitingColor = Math.random() < 0.5 ? BLUE : RED;
      const joiningColor = other(waitingColor);

      Object.assign(waitingInfo, {
        status: "matched",
        matchId,
        color: waitingColor
      });

      Object.assign(info, {
        status: "matched",
        matchId,
        color: joiningColor
      });

      waiting.serializeAttachment(waitingInfo);
      socket.serializeAttachment(info);

      const state = {
        phase: "dice",
        board: emptyBoard(),
        scores: [0, 0, 0],
        player: 0,
        startedAt: null,
        suddenDeath: false,
        gameOver: false,
        winner: null,
        reason: "",
        activePiece: null,
        fallAt: 0,
        fastDrop: false,
        diceRolls: { [BLUE]: null, [RED]: null },
        diceRound: 1,
        openingPlayer: null,
        setupPlaced: { [BLUE]: false, [RED]: false },
        setupColumns: { [BLUE]: null, [RED]: null },
        setupPlayer: null
      };

      await this.ctx.storage.put("game:" + matchId, state);

      this.send(waiting, {
        type: "match_found",
        matchId,
        color: waitingColor,
        opponentColor: joiningColor
      });

      this.send(socket, {
        type: "match_found",
        matchId,
        color: joiningColor,
        opponentColor: waitingColor
      });

      await this.broadcast(
        matchId,
        publicState(state, "Â¡Rival encontrado! Tirad los dados para decidir quiÃ©n empieza.")
      );

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

    if (info.status !== "matched" || !info.matchId) return;

    const matchId = info.matchId;
    const state = await this.getGame(matchId);

    if (!state || state.gameOver) return;

    if (msg.type === "roll_dice") {
      if (state.phase !== "dice") return;
      if (info.color !== BLUE && info.color !== RED) return;
      if (state.diceRolls[info.color] !== null) return;

      state.diceRolls[info.color] = 1 + Math.floor(Math.random() * 6);

      const blueRoll = state.diceRolls[BLUE];
      const redRoll = state.diceRolls[RED];

      if (blueRoll === null || redRoll === null) {
        await this.saveAndBroadcast(
          matchId,
          state,
          colorName(info.color) + " ha tirado los dados. Esperando al rival."
        );
        return;
      }

      if (blueRoll === redRoll) {
        state.diceRolls = { [BLUE]: null, [RED]: null };
        state.diceRound++;

        await this.saveAndBroadcast(
          matchId,
          state,
          "Ambos habÃ©is sacado " + blueRoll + ". Â¡Empate! Volved a tirar."
        );
        return;
      }

      const first = blueRoll > redRoll ? BLUE : RED;

      state.openingPlayer = first;
      state.setupPlayer = first;
      state.player = first;
      state.phase = "setup";

      await this.saveAndBroadcast(
        matchId,
        state,
        colorName(BLUE) + " ha sacado " + blueRoll +
          " y " + colorName(RED) + " ha sacado " + redRoll +
          ". Empieza " + colorName(first) +
          ", que debe elegir la primera columna."
      );

      return;
    }

    if (msg.type === "choose_column") {
      if (state.phase !== "setup") return;
      if (info.color !== state.setupPlayer) return;
      if (state.setupPlaced[info.color]) return;

      const x = Number(msg.x);

      if (!Number.isInteger(x) || x < 0 || x >= W) {
        this.send(socket, {
          type: "error",
          message: "Elige una columna vÃ¡lida."
        });
        return;
      }

      if (state.setupColumns[other(info.color)] === x) {
        this.send(socket, {
          type: "error",
          message: "Debes elegir una columna diferente a la del rival."
        });
        return;
      }

      if (state.board[H - 1][x] !== 0) {
        this.send(socket, {
          type: "error",
          message: "Esa columna no estÃ¡ disponible."
        });
        return;
      }

      state.board[H - 1][x] = info.color;
      state.setupPlaced[info.color] = true;
      state.setupColumns[info.color] = x;

      const opponent = other(info.color);

      if (!state.setupPlaced[opponent]) {
        state.setupPlayer = opponent;

        await this.saveAndBroadcast(
          matchId,
          state,
          colorName(info.color) +
            " ha colocado su cubo inicial. Ahora elige columna " +
            colorName(opponent) + "."
        );

        return;
      }

      state.phase = "playing";
      state.player = state.openingPlayer;
      state.startedAt = Date.now();

      await this.spawnServerPiece(state);

      await this.saveAndBroadcast(
        matchId,
        state,
        "Â¡Empieza la partida! Turno de " +
          colorName(state.player) + "."
      );

      return;
    }

    if (msg.type === "surrender") {
      if (info.color !== BLUE && info.color !== RED) return;

      finish(
        state,
        other(info.color),
        colorName(info.color) + " se ha rendido."
      );

      await this.saveAndBroadcast(matchId, state, state.reason);
      return;
    }

    if (msg.type === "control") {
      if (state.phase !== "playing") return;
      if (state.player !== info.color || !state.activePiece) return;

      checkTimeout(state);

      if (state.gameOver) {
        await this.saveAndBroadcast(matchId, state, state.reason);
        return;
      }

      const action = msg.action;

      if (action === "left" || action === "right") {
        const nx = state.activePiece.x + (action === "left" ? -1 : 1);
        const { y } = state.activePiece;

        if (
          nx >= 0 && nx < W &&
          state.board[y][nx] === 0
        ) {
          state.activePiece.x = nx;

          await this.ctx.storage.put("game:" + matchId, state);

          await this.broadcast(matchId, {
            type: "piece_motion",
            color: state.player,
            x: nx,
            y
          });
        }

        return;
      }

      if (action === "down_step") {
        state.fastDrop = false;
        state.fallAt = Date.now();

        await this.advanceGame(matchId, state, Date.now());
        return;
      }

      if (action === "down_start") {
        state.fastDrop = true;
        state.fallAt = Date.now();

        await this.ctx.storage.put("game:" + matchId, state);
        await this.scheduleAlarm(1);
        return;
      }

      if (action === "down_stop") {
        state.fastDrop = false;
        state.fallAt = Date.now() + 480;

        await this.ctx.storage.put("game:" + matchId, state);
        await this.scheduleAlarm(480);
      }

      return;
    }
  }

  async handleDisconnect(socket) {
    const info = socket.deserializeAttachment() || {};

    if (info.status === "queued") {
      info.status = "disconnected";
      socket.serializeAttachment(info);
      return;
    }

    if (info.status !== "matched" || !info.matchId) return;

    const state = await this.getGame(info.matchId);

    if (!state || state.gameOver) return;

    finish(
      state,
      other(info.color),
      "El rival se ha desconectado. Victoria para " +
        colorName(other(info.color)) + "."
    );

    await this.saveAndBroadcast(
      info.matchId,
      state,
      state.reason
    );
  }
}

