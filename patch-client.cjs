const fs = require("fs");

const file = "public/online.html";
let s = fs.readFileSync(file, "utf8");

function requireAnchor(anchor, label) {
  if (!s.includes(anchor)) throw new Error("No se encuentra " + label + ". Archivo sin modificar.");
}

requireAnchor("function movePiece(dx) {", "movePiece");
requireAnchor("function handleState(data) {", "handleState");
requireAnchor("function connectAndFind() {", "connectAndFind");
requireAnchor('} else if (data.type === "piece_motion") {', "el evento piece_motion");
requireAnchor('} else if (data.type === "match_found") {', "el evento match_found");
requireAnchor('$("down").addEventListener("pointerdown", () => {', "el control de caída rápida");
requireAnchor("function tick(now) {", "el bucle tick");

const handleStart = s.indexOf("function handleState(data) {");
const handleEnd = s.indexOf("\nfunction connectAndFind()", handleStart);
if (handleStart < 0 || handleEnd < 0) throw new Error("No se pudo delimitar handleState.");

const newHandleState = `function handleState(data) {
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
        ? "Muerte súbita. Tu turno: la siguiente captura decide."
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
      winner === 0 ? "¡Tablas!" : "¡Gana " + colorName(winner) + "!";
    $("resultText").textContent =
      (data.reason || "Partida finalizada") +
      " Marcador final: Azul " + scores[BLUE] +
      " — Rojo " + scores[RED] + ".";
    $("overlay").classList.add("show");
  } else {
    $("overlay").classList.remove("show");
  }

  render();
}
`;

s = s.slice(0, handleStart) + newHandleState + s.slice(handleEnd);

const moveStart = s.indexOf("function movePiece(dx) {");
const moveEnd = s.indexOf("\nfunction sendMove()", moveStart);
if (moveStart < 0 || moveEnd < 0) throw new Error("No se pudo delimitar movePiece.");

s = s.slice(0, moveStart) + `function sendControl(action) {
  if (!socket || socket.readyState !== WebSocket.OPEN || !gameStarted || gameOver) return;
  socket.send(JSON.stringify({ type: "control", action }));
}

function movePiece(dx) {
  if (!canControl()) return;
  sendControl(dx < 0 ? "left" : "right");
}
` + s.slice(moveEnd);

const pieceStart = s.indexOf('} else if (data.type === "piece_motion") {');
const matchStart = s.indexOf('} else if (data.type === "match_found") {', pieceStart);
if (pieceStart < 0 || matchStart < 0) throw new Error("No se pudo delimitar el evento piece_motion.");

s = s.slice(0, pieceStart) + `} else if (data.type === "piece_motion") {
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
      ` + s.slice(matchStart);

const downStart = s.indexOf('$("down").addEventListener("pointerdown", () => {');
const againStart = s.indexOf('$("again").addEventListener("click", () => {', downStart);
if (downStart < 0 || againStart < 0) throw new Error("No se pudo delimitar los controles de caída rápida.");

s = s.slice(0, downStart) + `  $("down").addEventListener("pointerdown", () => {
  if (canControl()) sendControl("down_start");
});
["pointerup","pointercancel","pointerleave"].forEach(eventName => {
  $("down").addEventListener(eventName, () => sendControl("down_stop"));
});

` + s.slice(againStart);

const keyStart = s.indexOf('document.addEventListener("keydown", event => {');
const tickStart = s.indexOf("function tick(now) {", keyStart);
if (keyStart < 0 || tickStart < 0) throw new Error("No se pudo delimitar los controles de teclado.");

s = s.slice(0, keyStart) + `document.addEventListener("keydown", event => {
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

` + s.slice(tickStart);

const tickEnd = s.indexOf('setInterval(() => {', s.indexOf("function tick(now) {"));
if (tickEnd < 0) throw new Error("No se pudo localizar el temporizador de ping.");

s = s.slice(0, s.indexOf("function tick(now) {")) + `function tick() {
  updateClock();
}

render();
setInterval(tick, 250);

` + s.slice(tickEnd);

const backup = file + ".before-server-controls-" + Date.now();
fs.copyFileSync(file, backup);

if (!s.includes('socket.send(JSON.stringify({ type: "control", action }));') ||
    !s.includes("activePiece") ||
    s.includes("requestAnimationFrame(tick)")) {
  throw new Error("La validación final ha fallado. No se ha escrito el nuevo cliente.");
}

fs.writeFileSync(file, s, "utf8");
console.log("Cliente actualizado. Copia anterior: " + backup);

