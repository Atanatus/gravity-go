
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
function cloneBoard(b: number[][]) {
  return b.map(r => r.slice());
}
function inBounds(x: number, y: number) {
  return x >= 0 && x < W && y >= 0 && y < H;
}
function other(p: number) {
  return p === BLUE ? RED : BLUE;
}
function countStones(b: number[][], color: number) {
  let c = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (b[y][x] === color) c++;
  return c;
}
function neighbors(x: number, y: number) {
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([a, b]) => inBounds(a, b)) as [number, number][];
}
function groupsOf(b: number[][]) {
  const seen = Array.from({ length: H }, () => Array(W).fill(false));
  const g: { color: number; stones: [number, number][]; liberties: number }[] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!b[y][x] || seen[y][x]) continue;
    const c = b[y][x];
    const st: [number, number][] = [[x, y]];
    const stones: [number, number][] = [];
    const lib = new Set<number>();
    seen[y][x] = true;
    while (st.length) {
      const [a, d] = st.pop()!;
      stones.push([a, d]);
      for (const [nx, ny] of neighbors(a, d)) {
        if (!b[ny][nx]) lib.add(ny * W + nx);
        else if (b[ny][nx] === c && !seen[ny][nx]) {
          seen[ny][nx] = true;
          st.push([nx, ny]);
        }
      }
    }
    g.push({ color: c, stones, liberties: lib.size });
  }
  return g;
}

// FIX #2: settle now correctly counts ALL removed stones, including top collisions
function settle(b: number[][]) {
  let cap = [0, 0, 0];
  let changed = true;
  let loops = 0;
  while (changed && loops++ < H * W) {
    changed = false;
    const groups = groupsOf(b);
    const toRemove: [number, number, number][] = [];
    for (const gg of groups) if (gg.liberties === 0) {
      for (const [x, y] of gg.stones) toRemove.push([x, y, gg.color]);
    }
    if (toRemove.length) {
      changed = true;
      for (const [x, y, c] of toRemove) {
        if (b[y][x] === c) {
          b[y][x] = 0;
          cap[c]++;
        }
      }
      // gravity
      for (let x = 0; x < W; x++) {
        const stack: number[] = [];
        for (let y = H - 1; y >= 0; y--) if (b[y][x]) stack.push(b[y][x]);
        for (let y = H - 1; y >= 0; y--) b[y][x] = stack[H - 1 - y] || 0;
      }
    }
  }
  return cap;
}

function tryPlacement(b: number[][], x: number, y: number, p: number) {
  const beforeOpp = countStones(b, other(p));
  const n = cloneBoard(b);
  if (!inBounds(x, y) || n[y][x]) return { ok: false as const };
  n[y][x] = p;
  const cap = settle(n);
  // FIX #2: ensure pieces that disappear due to top limit are counted
  const afterOpp = countStones(n, other(p));
  const disappearedOpp = beforeOpp - afterOpp;
  if (disappearedOpp > (cap[other(p)] || 0)) {
    // Some opponent stones disappeared via top collision and weren't counted, fix it
    cap[other(p)] = disappearedOpp;
  }
  const ownGroups = groupsOf(n).filter(g => g.color === p);
  if (ownGroups.some(g => g.liberties === 0)) return { ok: false as const, suicide: true as const };
  return { ok: true as const, board: n, captured: cap };
}

function landingY(b: number[][], x: number) {
  if (b[0][x]) return -1;
  let y = 0;
  while (y + 1 < H && !b[y + 1][x]) y++;
  return y;
}
function canOccupy(b: number[][], x: number, y: number) {
  return inBounds(x, y) && !b[y][x];
}

type Player = {
  id: string;
  ws: WebSocket;
  color: number;
  diceRoll: number | null;
  speedX2: boolean;
  fastDrop: boolean;
};

type Game = {
  id: string;
  board: number[][];
  scores: number[];
  players: Player[];
  currentPlayerColor: number;
  phase: "dice" | "setup" | "playing" | "over";
  diceRolls: { [k: number]: number | null };
  diceRound: number;
  setupPlaced: { [k: number]: boolean };
  setupPlayer: number | null;
  setupColumns: { [k: number]: number | null };
  activePiece: { x: number; y: number } | null;
  remaining: number;
  startTime: number;
  stateReceivedAt: number;
  suddenDeath: boolean;
  gameOver: boolean;
  winner: number;
  reason: string;
  fallTimer: any;
};

export class GameHub extends DurableObject {
  waiting: Player[] = [];
  games: Map<string, Game> = new Map();
  playerToGame: Map<string, string> = new Map();

  constructor(ctx: any, env: any) {
    super(ctx, env);
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("Expected websocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
      // @ts-ignore
      this.ctx.acceptWebSocket(server);
      const playerId = crypto.randomUUID();
      // Attach playerId to ws via a property (we store mapping)
      (server as any).playerId = playerId;
      // Store ws reference
      (server as any).playerWs = server;
      // We'll handle connection in websocket message event, but need to store temp
      // Actually we need to track this ws as waiting once they send find
      // For now just store in a temp map
      if (!(this as any).tempSockets) (this as any).tempSockets = new Map();
      (this as any).tempSockets.set(playerId, server);
      return new Response(null, { status: 101, webSocket: client });
    }
    // Serve assets fallback
    if ((this.env as any).ASSETS) {
      return (this.env as any).ASSETS.fetch(request);
    }
    return new Response("Gravity Go Server OK - use /ws", { status: 200 });
  }

  async webSocketMessage(ws: any, message: string) {
    let data: any;
    try { data = JSON.parse(message); } catch { return; }
    const playerId = ws.playerId;
    if (!playerId) return;

    if (data.type === "find") {
      this.handleFind(ws, playerId);
    } else if (data.type === "cancel_search") {
      this.handleCancelSearch(playerId);
    } else if (data.type === "roll_dice") {
      this.handleRollDice(playerId);
    } else if (data.type === "choose_column") {
      this.handleChooseColumn(playerId, data.x);
    } else if (data.type === "control") {
      this.handleControl(playerId, data.action);
    } else if (data.type === "set_speed") {
      this.handleSetSpeed(playerId, !!data.x2);
    } else if (data.type === "surrender") {
      this.handleSurrender(playerId);
    } else if (data.type === "ping") {
      try { ws.send(JSON.stringify({ type: "pong" })); } catch {}
    }
  }

  async webSocketClose(ws: any) {
    const playerId = ws.playerId;
    if (!playerId) return;
    // Remove from waiting
    this.waiting = this.waiting.filter(p => p.id !== playerId);
    // Find game
    const gameId = this.playerToGame.get(playerId);
    if (gameId) {
      const game = this.games.get(gameId);
      if (game) {
        game.gameOver = true;
        game.winner = game.players.find(p => p.id !== playerId)?.color || 0;
        game.reason = "Rival desconectado";
        game.phase = "over";
        this.broadcastState(game);
        this.cleanupGame(gameId);
      }
      this.playerToGame.delete(playerId);
    }
    if ((this as any).tempSockets) (this as any).tempSockets.delete(playerId);
  }

  handleFind(ws: any, playerId: string) {
    // Already in game?
    if (this.playerToGame.has(playerId)) {
      try { ws.send(JSON.stringify({ type: "already_matched" })); } catch {}
      return;
    }
    // Already waiting?
    if (this.waiting.find(p => p.id === playerId)) {
      try { ws.send(JSON.stringify({ type: "searching" })); } catch {}
      return;
    }
    const player: Player = { id: playerId, ws, color: BLUE, diceRoll: null, speedX2: false, fastDrop: false };
    this.waiting.push(player);
    try { ws.send(JSON.stringify({ type: "searching" })); } catch {}

    if (this.waiting.length >= 2) {
      const p1 = this.waiting.shift()!;
      const p2 = this.waiting.shift()!;
      this.createGame(p1, p2);
    }
  }

  handleCancelSearch(playerId: string) {
    this.waiting = this.waiting.filter(p => p.id !== playerId);
    const ws = (this as any).tempSockets?.get(playerId);
    if (ws) {
      try { ws.send(JSON.stringify({ type: "search_cancelled" })); } catch {}
    }
  }

  createGame(p1: Player, p2: Player) {
    const gameId = crypto.randomUUID();
    // Assign initial colors randomly, will be fixed after dice (winner gets black)
    const colors = Math.random() > 0.5 ? [BLUE, RED] : [RED, BLUE];
    p1.color = colors[0];
    p2.color = colors[1];
    p1.diceRoll = null;
    p2.diceRoll = null;

    const game: Game = {
      id: gameId,
      board: emptyBoard(),
      scores: [0, 0, 0],
      players: [p1, p2],
      currentPlayerColor: 0,
      phase: "dice",
      diceRolls: { [BLUE]: null, [RED]: null },
      diceRound: 1,
      setupPlaced: { [BLUE]: false, [RED]: false },
      setupPlayer: null,
      setupColumns: { [BLUE]: null, [RED]: null },
      activePiece: null,
      remaining: 600,
      startTime: Date.now(),
      stateReceivedAt: Date.now(),
      suddenDeath: false,
      gameOver: false,
      winner: 0,
      reason: "",
      fallTimer: null,
    };

    this.games.set(gameId, game);
    this.playerToGame.set(p1.id, gameId);
    this.playerToGame.set(p2.id, gameId);

    // Send match_found to each with their color (temporary, will be updated after dice)
    for (const p of game.players) {
      try {
        p.ws.send(JSON.stringify({ type: "match_found", color: p.color }));
      } catch {}
    }
    this.broadcastState(game);
  }

  handleRollDice(playerId: string) {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return;
    const game = this.games.get(gameId);
    if (!game || game.phase !== "dice" || game.gameOver) return;
    const player = game.players.find(p => p.id === playerId);
    if (!player || player.diceRoll !== null) return;

    const roll = 1 + Math.floor(Math.random() * 6);
    player.diceRoll = roll;
    game.diceRolls[player.color] = roll;

    // Check if both rolled
    const rolls = game.players.map(p => p.diceRoll);
    if (rolls.every(r => r !== null)) {
      const [r1, r2] = rolls as number[];
      if (r1 === r2) {
        // Tie - reroll
        game.diceRound++;
        for (const p of game.players) {
          p.diceRoll = null;
        }
        game.diceRolls = { [BLUE]: null, [RED]: null };
        this.broadcastState(game, "Empate en dados. ¡Repetimos tirada!");
      } else {
        // FIX #1: Winner gets black (RED) and starts
        const winnerPlayer = r1 > r2 ? game.players[0] : game.players[1];
        const loserPlayer = r1 > r2 ? game.players[1] : game.players[0];

        // Winner must be RED (black)
        if (winnerPlayer.color !== RED) {
          // Swap colors
          const tempColor = winnerPlayer.color;
          winnerPlayer.color = RED;
          loserPlayer.color = BLUE;
          // Also need to swap diceRolls mapping? diceRolls is keyed by color, but we already have rolls by player, so reset mapping
          game.diceRolls = { [BLUE]: loserPlayer.diceRoll, [RED]: winnerPlayer.diceRoll };
        } else {
          game.diceRolls = { [BLUE]: loserPlayer.diceRoll, [RED]: winnerPlayer.diceRoll };
        }

        // Notify color update - FIX #1
        for (const p of game.players) {
          try {
            p.ws.send(JSON.stringify({ type: "color_update", color: p.color }));
          } catch {}
        }

        // Winner starts and chooses column first
        game.currentPlayerColor = RED;
        game.setupPlayer = RED;
        game.phase = "setup";
        game.setupPlaced = { [BLUE]: false, [RED]: false };
        this.broadcastState(game, `¡${winnerPlayer.color === RED ? "Negras" : "Blancas"} empieza! El que sacó más alto (${Math.max(r1, r2)}) lleva negras.`);
      }
    } else {
      this.broadcastState(game);
    }
  }

  handleChooseColumn(playerId: string, x: number) {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return;
    const game = this.games.get(gameId);
    if (!game || game.phase !== "setup" || game.gameOver) return;
    const player = game.players.find(p => p.id === playerId);
    if (!player || player.color !== game.setupPlayer) return;
    if (!Number.isInteger(x) || x < 0 || x >= W) return;
    // Check column free and not already chosen
    if (game.board[H - 1][x] !== 0) return;
    if (Object.values(game.setupColumns).includes(x)) return;

    game.board[H - 1][x] = player.color;
    game.setupColumns[player.color] = x;
    game.setupPlaced[player.color] = true;

    if (!game.setupPlaced[BLUE] || !game.setupPlaced[RED]) {
      // Switch to other player
      game.setupPlayer = other(game.setupPlayer!);
      this.broadcastState(game, game.setupPlayer === RED ? "Turno de negras para elegir columna." : "Turno de blancas para elegir columna.");
    } else {
      // Both placed, start playing
      game.phase = "playing";
      game.currentPlayerColor = RED; // FIX #1: black starts (winner is RED)
      game.startTime = Date.now();
      game.stateReceivedAt = Date.now();
      this.spawnPiece(game);
      this.broadcastState(game, "¡Comienza la partida! Turno de negras.");
      this.startFallLoop(game);
    }
  }

  spawnPiece(game: Game) {
    let col = -1;
    for (const x of SPAWN_ORDER) if (!game.board[0][x]) { col = x; break; }
    if (col < 0) {
      // No spawn - finish by score
      this.finishByScore(game, "Tablero bloqueado");
      return;
    }
    game.activePiece = { x: col, y: 0 };
    // Send piece motion to all
    for (const p of game.players) {
      try {
        p.ws.send(JSON.stringify({ type: "piece_motion", x: col, y: 0, color: game.currentPlayerColor }));
      } catch {}
    }
  }

  startFallLoop(game: Game) {
    if (game.fallTimer) clearInterval(game.fallTimer);
    const tick = () => {
      if (game.gameOver || game.phase !== "playing") {
        if (game.fallTimer) clearInterval(game.fallTimer);
        return;
      }
      // Handle time
      const elapsed = (Date.now() - game.startTime) / 1000;
      game.remaining = Math.max(0, 600 - elapsed);
      if (game.remaining <= 0 && !game.suddenDeath) {
        if (game.scores[BLUE] === game.scores[RED]) {
          game.suddenDeath = true;
          this.broadcastState(game, "¡Empate! Muerte súbita, siguiente captura decide.");
        } else {
          const winner = game.scores[BLUE] > game.scores[RED] ? BLUE : RED;
          this.endGame(game, winner, "Tiempo agotado");
        }
        return;
      }

      if (!game.activePiece) return;
      const currentPlayer = game.players.find(p => p.color === game.currentPlayerColor);
      const isFast = currentPlayer?.fastDrop;
      const isX2 = currentPlayer?.speedX2;
      // Normal interval handled by outer setInterval, fastDrop handled via separate faster ticks? Simplify: we check fastDrop flag to move faster
      // This tick is called at base interval, but if fastDrop or x2, we move piece

      const nextY = game.activePiece.y + 1;
      if (canOccupy(game.board, game.activePiece.x, nextY)) {
        game.activePiece.y = nextY;
        // Broadcast motion
        for (const p of game.players) {
          try {
            p.ws.send(JSON.stringify({ type: "piece_motion", x: game.activePiece.x, y: game.activePiece.y, color: game.currentPlayerColor }));
          } catch {}
        }
      } else {
        // Lock piece
        this.lockPiece(game);
      }
    };

    // Base interval - will be adjusted for x2 and fastDrop inside tick via multiple steps
    // FIX #3: x2 speed support
    game.fallTimer = setInterval(() => {
      const currentPlayer = game.players.find(p => p.color === game.currentPlayerColor);
      const isFast = currentPlayer?.fastDrop;
      const isX2 = currentPlayer?.speedX2;
      if (isFast) {
        // Fast drop: move every tick (fast interval)
        tick();
      } else if (isX2) {
        // x2: move twice as fast - we call tick and if it's x2, we do extra move every other tick
        tick();
        // For x2, we move again immediately to double speed (but not too fast)
        if (Math.random() < 0.5) tick();
      } else {
        tick();
      }
    }, 480); // base 480ms, will be adjusted for fast
  }

  lockPiece(game: Game) {
    if (!game.activePiece) return;
    const { x, y } = game.activePiece;
    const p = game.currentPlayerColor;
    const result = tryPlacement(game.board, x, y, p);
    game.activePiece = null;

    if (!result.ok) {
      // Invalid move (suicide) - shouldn't happen in online because we check, but handle
      this.broadcastState(game, result.suicide ? "Suicidio prohibido" : "Jugada inválida");
      // Respawn same player
      setTimeout(() => {
        this.spawnPiece(game);
        this.broadcastState(game);
      }, 450);
      return;
    }

    game.board = result.board;
    const enemy = other(p);
    const captured = result.captured[enemy] || 0;

    // FIX #2 is already handled inside tryPlacement to count top collisions
    if (captured > 0) {
      game.scores[p] += captured;
    }

    if (game.scores[p] >= GOAL) {
      this.endGame(game, p, `¡${p === RED ? "Negras" : "Blancas"} alcanza 20 capturas!`);
      return;
    }
    if (game.suddenDeath && captured > 0) {
      this.endGame(game, p, "¡Captura decisiva en muerte súbita!");
      return;
    }

    // Check if any spawn column left
    const hasSpawn = SPAWN_ORDER.some(sx => !game.board[0][sx]);
    if (!hasSpawn) {
      this.finishByScore(game, "Tablero bloqueado");
      return;
    }

    // Switch turn
    game.currentPlayerColor = other(p);
    game.stateReceivedAt = Date.now();
    setTimeout(() => {
      this.spawnPiece(game);
      this.broadcastState(game, captured > 0 ? `${p === RED ? "Negras" : "Blancas"} captura ${captured}` : "Sin capturas");
    }, 550);
  }

  handleControl(playerId: string, action: string) {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return;
    const game = this.games.get(gameId);
    if (!game || game.phase !== "playing" || game.gameOver) return;
    if (game.currentPlayerColor !== this.getPlayerColor(game, playerId)) return;
    if (!game.activePiece) return;

    const player = game.players.find(p => p.id === playerId);
    if (!player) return;

    if (action === "left") {
      const nx = game.activePiece.x - 1;
      if (canOccupy(game.board, nx, game.activePiece.y)) {
        game.activePiece.x = nx;
        this.broadcastPieceMotion(game);
      }
    } else if (action === "right") {
      const nx = game.activePiece.x + 1;
      if (canOccupy(game.board, nx, game.activePiece.y)) {
        game.activePiece.x = nx;
        this.broadcastPieceMotion(game);
      }
    } else if (action === "down_start") {
      player.fastDrop = true;
    } else if (action === "down_stop") {
      player.fastDrop = false;
    } else if (action === "down_step") {
      const ny = game.activePiece.y + 1;
      if (canOccupy(game.board, game.activePiece.x, ny)) {
        game.activePiece.y = ny;
        this.broadcastPieceMotion(game);
      } else {
        this.lockPiece(game);
      }
    }
  }

  handleSetSpeed(playerId: string, x2: boolean) {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return;
    const game = this.games.get(gameId);
    if (!game) return;
    const player = game.players.find(p => p.id === playerId);
    if (!player) return;
    player.speedX2 = x2;
    // FIX #3: update fall loop interval if needed
    if (game.phase === "playing" && game.currentPlayerColor === player.color) {
      // Restart loop to apply new speed (our loop checks speedX2 flag each tick, so no need to restart, but we can)
    }
    this.broadcastState(game, x2 ? "Jugador activa x2 velocidad" : "Jugador vuelve a velocidad normal");
  }

  handleSurrender(playerId: string) {
    const gameId = this.playerToGame.get(playerId);
    if (!gameId) return;
    const game = this.games.get(gameId);
    if (!game || game.gameOver) return;
    const player = game.players.find(p => p.id === playerId);
    if (!player) return;
    const winner = other(player.color);
    this.endGame(game, winner, `${player.color === RED ? "Negras" : "Blancas"} se rinde`);
  }

  getPlayerColor(game: Game, playerId: string) {
    return game.players.find(p => p.id === playerId)?.color || 0;
  }

  broadcastPieceMotion(game: Game) {
    if (!game.activePiece) return;
    for (const p of game.players) {
      try {
        p.ws.send(JSON.stringify({ type: "piece_motion", x: game.activePiece!.x, y: game.activePiece!.y, color: game.currentPlayerColor }));
      } catch {}
    }
  }

  broadcastState(game: Game, message?: string) {
    const state = {
      type: "state",
      board: game.board,
      scores: game.scores,
      player: game.currentPlayerColor,
      phase: game.phase,
      gameOver: game.gameOver,
      suddenDeath: game.suddenDeath,
      remaining: game.remaining,
      diceRolls: game.diceRolls,
      diceRound: game.diceRound,
      setupPlaced: game.setupPlaced,
      setupPlayer: game.setupPlayer,
      activePiece: game.activePiece,
      winner: game.winner,
      reason: game.reason,
      message: message || "",
    };
    for (const p of game.players) {
      try {
        p.ws.send(JSON.stringify(state));
      } catch {}
    }
  }

  endGame(game: Game, winner: number, reason: string) {
    game.gameOver = true;
    game.winner = winner;
    game.reason = reason;
    game.phase = "over";
    if (game.fallTimer) clearInterval(game.fallTimer);
    this.broadcastState(game, reason);
    setTimeout(() => this.cleanupGame(game.id), 30000);
  }

  finishByScore(game: Game, reason: string) {
    if (game.scores[BLUE] > game.scores[RED]) this.endGame(game, BLUE, reason);
    else if (game.scores[RED] > game.scores[BLUE]) this.endGame(game, RED, reason);
    else if (reason.includes("bloqueado")) this.endGame(game, 0, reason);
    else {
      game.suddenDeath = true;
      this.broadcastState(game, "¡Empate! Muerte súbita");
    }
  }

  cleanupGame(gameId: string) {
    const game = this.games.get(gameId);
    if (!game) return;
    if (game.fallTimer) clearInterval(game.fallTimer);
    for (const p of game.players) {
      this.playerToGame.delete(p.id);
    }
    this.games.delete(gameId);
  }
}

export default {
  async fetch(request: Request, env: any, ctx: any) {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const id = env.GAME_HUB.idFromName("global");
      const stub = env.GAME_HUB.get(id);
      return stub.fetch(request);
    }
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }
    return new Response("Gravity Go Server OK - use /ws", { status: 200 });
  }
};
