const fs = require("fs");
const html = fs.readFileSync("public/online.html", "utf8");
const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
if (!scripts.length) throw new Error("No se encontraron scripts.");
scripts.forEach((m, i) => fs.writeFileSync(`.client-check-${i}.cjs`, m[1]));
console.log("Scripts encontrados:", scripts.length);
