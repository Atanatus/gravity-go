
"use strict";

const W = 8, H = 12, BLUE = 1, RED = 2;
const SPAWN_ORDER = [3,4,2,5,1,6,0,7];
const $ = id => document.getElementById(id);

let socket = null;
let ownColor = 0;
let board = Array.from({length:H}, () => Array(W).fill(0));
let piece = null;
let remotePiece = null;
let lastMotionSentAt = 0;
let currentPlayer = 0;
let scores = [0,0,0];
let gameStarted = false;
let gameOver = false;
let waitingForState = false;
let searching = false;
let fastDrop = false;
let lastFrame = 0;
let fallAccumulator = 0;
let serverRemaining = 600;
let stateReceivedAt = Date.now();
let lastBoardKey = "";
let lastMessage = "Pulsa Â«Buscar rivalÂ» para encontrar una partida.";
let suddenDeath = false;

function say(message) {
  lastMessage = message || "";
  $("status").textContent = lastMessage;
}

function other(player) {
  return player === BLUE ? RED : BLUE;
}

function colorName(player) {
  return player === BLUE ? "Blanco" : "Negro";
}

function canOccupy(x,y) {
  return x >= 0 && x < W && y >= 0 && y < H && !board[y][x];
}

function boardKeyOf(b) {
  return b.map(row => row.join("")).join("/");
}

function spawnPiece() {
  for (const x of SPAWN_ORDER) {
    if (!board[0][x]) {
      piece = {x, y:0};
      fallAccumulator = 0;
      fastDrop = false;
      sendPieceMotion(true);
      return;
    }
  }
  piece = null;
}

function sendPieceMotion(force = false) {
  if (!canControl() || !piece) return;

  const now = Date.now();
  if (!force && now - lastMotionSentAt < 50) return;
  lastMotionSentAt = now;

  socket.send(JSON.stringify({
    type: "piece_motion",
    x: piece.x,
    y: piece.y,
    color: ownColor
  }));
}

function updateClock() {
  const elapsed = (Date.now() - stateReceivedAt) / 1000;
  const n = Math.max(0, Math.ceil(serverRemaining - elapsed));
  $("time").textContent =
    String(Math.floor(n/60)).padStart(2,"0") + ":" +
    String(n%60).padStart(2,"0");
  $("clock").classList.toggle("urgent", n <= 60);
}

function render() {
  const el = $("board");
  el.replaceChildren();

  for (let y=0; y<H; y++) {
    for (let x=0; x<W; x++) {
      const cell = document.createElement("div");
      cell.className = "cell" +
        (board[y][x] === BLUE ? " blue" :
         board[y][x] === RED ? " red" : "");

      if (piece && piece.x === x && piece.y === y) {
        cell.classList.add("falling");
      }

      if (remotePiece && remotePiece.x === x && remotePiece.y === y) {
        cell.classList.add("remote-falling");
        cell.classList.add(remotePiece.color === BLUE ? "blue" : "red");
      }

      cell.setAttribute("aria-label", `Fila ${y+1}, columna ${x+1}`);
      cell.addEventListener("click", () => {
        if (!canControl()) return;
        if (x !== piece.x) movePiece(Math.sign(x-piece.x));
      });
      el.appendChild(cell);
    }
  }

  $("scoreBlue").textContent = scores[BLUE];
  $("scoreRed").textContent = scores[RED];
  $("pBlue").classList.toggle("active", !gameOver && currentPlayer === BLUE);
  $("pRed").classList.toggle("active", !gameOver && currentPlayer === RED);
  $("redName").textContent = "JUGADOR NEGRO";

  const controlsEnabled = canControl();
  $("left").disabled = !controlsEnabled;
  $("right").disabled = !controlsEnabled;
  $("down").disabled = !controlsEnabled;
  $("find").disabled = searching || gameStarted;
  $("cancel").disabled = !searching;

  updateClock();
}

function canControl() {
  return gameStarted && !gameOver && !waitingForState &&
    currentPlayer === ownColor && !!piece && socket &&
    socket.readyState === WebSocket.OPEN;
}

function sendControl(action) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !gameStarted || gameOver) return;
  socket.send(JSON.stringify({ type: "control", action }));
}

function movePiece(dx) {
  if (!canControl()) return;
  sendControl(dx < 0 ? "left" : "right");
}

function sendMove() {
  if (!canControl()) return;
  const x = piece.x;
  piece = null;
  waitingForState = true;
  fastDrop = false;
  socket.send(JSON.stringify({type:"move", x}));
  say("Jugada enviada. Esperando al servidor...");
  render();
}

function handleState(data) {
  const previousPlayer = currentPlayer;
  const previousBoardKey = lastBoardKey;

  board = data.board;
  scores = data.scores;
  currentPlayer = data.player;
  gameOver = data.gameOver;
  suddenDeath = data.suddenDeath;
  serverRemaining = data.remaining;
  stateReceivedAt = Date.now();
  lastBoardKey = boardKeyOf(board);
  waitingForState = false;

  const active = data.activePiece &&
    Number.isInteger(data.activePiece.x) &&
    Number.isInteger(data.activePiece.y)
      ? { x: data.activePiece.x, y: data.activePiece.y, color: currentPlayer }
      : null;

  if (currentPlayer === ownColor) {
    piece = active ? { x: active.x, y: active.y } : null;
    remotePiece = null;
  } else {
    piece = null;
    remotePiece = active;
  }

  if (data.message) say(data.message);
  else if (previousPlayer !== currentPlayer) {
    say(currentPlayer === ownColor
      ? (suddenDeath
        ? "Muerte sÃºbita. Tu turno: la siguiente captura decide."
        : "Tu turno. Mueve tu cubo.")
      : "Turno del rival. Esperando su jugada...");
  } else if (previousBoardKey !== lastBoardKey && currentPlayer === ownColor) {
    say("Tu turno. Mueve tu cubo.");
  }

  if (gameOver) {
    piece = null;
    remotePiece = null;
    const winner = data.winner;
    $("resultTitle").textContent =
      winner === 0 ? "Â¡Tablas!" : "Â¡Gana " + colorName(winner) + "!";
    $("resultText").textContent =
      (data.reason || "Partida finalizada") +
      " Marcador final: Azul " + scores[BLUE] +
      " â€” Rojo " + scores[RED] + ".";
    $("overlay").classList.add("show");
  } else {
    $("overlay").classList.remove("show");
  }

  render();
}

function connectAndFind() {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({type:"find"}));
    searching = true;
    say("Buscando rival...");
    render();
    return;
  }

  if (socket && socket.readyState === WebSocket.CONNECTING) {
    say("Conectando al servidor...");
    return;
  }

  searching = true;
  say("Conectando al servidor...");
  render();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(protocol + "//" + location.host + "/ws");

  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({type:"find"}));
    say("Buscando rival...");
    render();
  });

  socket.addEventListener("message", event => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      say("Respuesta no vÃ¡lida del servidor.");
      return;
    }

    if (data.type === "searching") {
      searching = true;
      say("Buscando rival. Deja esta pÃ¡gina abierta...");
      render();
    } else if (data.type === "piece_motion") {
      if (
        gameStarted &&
        Number.isInteger(data.x) &&
        Number.isInteger(data.y) &&
        data.x >= 0 && data.x < W &&
        data.y >= 0 && data.y < H
      ) {
        const moving = { x: data.x, y: data.y, color: data.color };
        if (data.color === ownColor) {
          piece = { x: moving.x, y: moving.y };
          remotePiece = null;
        } else {
          piece = null;
          remotePiece = moving;
        }
        render();
      }
    } else if (data.type === "match_found") {
      searching = false;
      ownColor = data.color;
      gameStarted = true;
      gameOver = false;
      waitingForState = false;
      piece = null;
      remotePiece = null;
      currentPlayer = 0;
      lastBoardKey = "";
      say("Â¡Rival encontrado! Preparando partida...");
      render();
    } else if (data.type === "state") {
      if (!gameStarted) return;
      handleState(data);
    } else if (data.type === "search_cancelled") {
      searching = false;
      say("BÃºsqueda cancelada.");
      render();
    } else if (data.type === "opponent_disconnected") {
      say(data.message || "El rival se ha desconectado.");
    } else if (data.type === "error") {
      say(data.message || "Error del servidor.");
    } else if (data.type === "already_matched") {
      say("Ya estÃ¡s en una partida.");
    }
  });

  socket.addEventListener("close", () => {
    searching = false;
    gameStarted = false;
    piece = null;
    waitingForState = false;
    say("ConexiÃ³n cerrada. Pulsa Buscar rival para volver a conectar.");
    render();
  });

  socket.addEventListener("error", () => {
    say("No se pudo conectar. Comprueba que el servidor estÃ© activo.");
  });
}

function cancelSearch() {
  if (searching && socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({type:"cancel_search"}));
  }
}

$("find").addEventListener("click", connectAndFind);
$("cancel").addEventListener("click", cancelSearch);
$("left").addEventListener("click", () => movePiece(-1));
$("right").addEventListener("click", () => movePiece(1));

  $("down").addEventListener("pointerdown", () => {
  if (canControl()) sendControl("down_start");
});
["pointerup","pointercancel","pointerleave"].forEach(eventName => {
  $("down").addEventListener(eventName, () => sendControl("down_stop"));
});

$("again").addEventListener("click", () => {
  $("overlay").classList.remove("show");
  gameStarted = false;
  gameOver = false;
  ownColor = 0;
  piece = null;
  waitingForState = false;
  searching = false;
  board = Array.from({length:H}, () => Array(W).fill(0));
  scores = [0,0,0];
  render();
  connectAndFind();
});

document.addEventListener("keydown", event => {
  if (["ArrowLeft","ArrowRight","ArrowDown"," "].includes(event.key)) {
    event.preventDefault();
  }
  if (event.repeat && event.key !== "ArrowDown") return;
  if (event.key === "ArrowLeft") movePiece(-1);
  if (event.key === "ArrowRight") movePiece(1);
  if (event.key === "ArrowDown" && canControl()) sendControl("down_start");
});

document.addEventListener("keyup", event => {
  if (event.key === "ArrowDown") sendControl("down_stop");
});

function tick() {
  updateClock();
}

render();
setInterval(tick, 250);

setInterval(() => {
  if (socket && socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({type:"ping"}));
  }
}, 1500);
