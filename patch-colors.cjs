const fs = require("fs");

const clientFile = "public/online.html";
const serverFile = "src/index.js";

let client = fs.readFileSync(clientFile, "utf8");
let server = fs.readFileSync(serverFile, "utf8");

function replaceOnce(source, from, to, label) {
  const count = source.split(from).length - 1;
  if (count !== 1) {
    throw new Error(label + ": se esperaba una coincidencia y se encontraron " + count);
  }
  return source.replace(from, to);
}

// CLIENTE: diseño monocromático y nombres visibles.
client = replaceOnce(
  client,
  ".cell.blue::after{background:var(--blue);box-shadow:0 0 10px #39a9ff65}",
  ".cell.blue::after{background:#f5f5f5;border:1px solid #fff;box-shadow:0 0 7px #ffffff35}",
  "estilo de fichas blancas"
);

client = replaceOnce(
  client,
  ".cell.red::after{background:var(--red);box-shadow:0 0 10px #ff526965}",
  ".cell.red::after{background:#080a0e;border:1px solid #d8dce4;box-shadow:inset 0 0 0 1px #000}",
  "estilo de fichas negras"
);

client = replaceOnce(
  client,
  ".blue .score{color:var(--blue)}.red .score{color:var(--red)}",
  ".blue .score{color:#f5f5f5}.red .score{color:#aeb5c0}",
  "colores de puntuación"
);

client = replaceOnce(client, "JUGADOR AZUL", "JUGADOR BLANCO", "etiqueta del jugador blanco");
client = client.replaceAll("JUGADOR ROJO", "JUGADOR NEGRO");

const colorFunction = /function colorName\(player\)\s*\{[\s\S]*?\n\}/;
if (!colorFunction.test(client)) {
  throw new Error("No se encuentra colorName; cliente sin escribir.");
}
client = client.replace(
  colorFunction,
  'function colorName(player) {\n  return player === BLUE ? "Blanco" : "Negro";\n}'
);

// SERVIDOR: sorteo 50/50 independiente del orden de llegada.
server = replaceOnce(
  server,
  `      waitingInfo.color = BLUE;
      waiting.serializeAttachment(waitingInfo);

      info.status = "matched";
      info.matchId = matchId;
      info.color = RED;
      socket.serializeAttachment(info);`,
  `      const waitingColor = Math.random() < 0.5 ? BLUE : RED;
      const joiningColor = waitingColor === BLUE ? RED : BLUE;

      waitingInfo.color = waitingColor;
      waiting.serializeAttachment(waitingInfo);

      info.status = "matched";
      info.matchId = matchId;
      info.color = joiningColor;
      socket.serializeAttachment(info);`,
  "asignación aleatoria de colores"
);

server = replaceOnce(
  server,
  `        color: BLUE,
        opponentColor: RED`,
  `        color: waitingColor,
        opponentColor: joiningColor`,
  "colores enviados al jugador que esperaba"
);

server = replaceOnce(
  server,
  `        color: RED,
        opponentColor: BLUE`,
  `        color: joiningColor,
        opponentColor: waitingColor`,
  "colores enviados al jugador que se incorpora"
);

// Mantener los identificadores internos BLUE/RED, pero mostrar blanco/negro.
server = replaceOnce(
  server,
  'finish(state, mover, "¡" + (mover === BLUE ? "Azul" : "Rojo") + " alcanza las 20 capturas!");',
  'finish(state, mover, "¡" + (mover === BLUE ? "Blanco" : "Negro") + " alcanza las 20 capturas!");',
  "mensaje de victoria por capturas"
);
server = replaceOnce(
  server,
  '? (mover === BLUE ? "Azul" : "Rojo") + " captura " + gained + " cubo(s)."',
  '? (mover === BLUE ? "Blanco" : "Negro") + " captura " + gained + " cubo(s)."',
  "mensaje de capturas"
);

// Validar los cambios en memoria antes de crear copias y escribir.
if (!client.includes('return player === BLUE ? "Blanco" : "Negro";') ||
    !client.includes('JUGADOR BLANCO') ||
    !client.includes('JUGADOR NEGRO') ||
    !client.includes('setInterval(tick, 250)')) {
  throw new Error("La validación del cliente ha fallado; no se han escrito cambios.");
}
if (!server.includes("const waitingColor = Math.random() < 0.5 ? BLUE : RED;") ||
    !server.includes("color: waitingColor") ||
    !server.includes("color: joiningColor")) {
  throw new Error("La validación del servidor ha fallado; no se han escrito cambios.");
}

// Copias de seguridad de los archivos exactos anteriores a este parche.
const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
fs.copyFileSync(clientFile, clientFile + ".before-monochrome-" + stamp);
fs.copyFileSync(serverFile, serverFile + ".before-random-colors-" + stamp);

fs.writeFileSync(clientFile, client, "utf8");
fs.writeFileSync(serverFile, server, "utf8");

console.log("Cambios aplicados. Copias de seguridad creadas.");


