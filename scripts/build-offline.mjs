import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const output = new URL("../dist/", import.meta.url);
async function list(directory, prefix = "") {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix + entry.name;
    if (entry.isDirectory())
      paths.push(...(await list(new URL(entry.name + "/", directory), relative + "/")));
    else if (entry.name !== "sw.js") paths.push(relative);
  }
  return paths.sort();
}
const files = await list(output);
const hash = createHash("sha256");
for (const file of files) {
  hash.update(file);
  hash.update(await readFile(new URL(file, output)));
}
const version = hash.digest("hex").slice(0, 16);
const urls = files.map((file) => "./" + file);
const worker = [
  'const CACHE = "iatron-offline-' + version + '";',
  "const FILES = " + JSON.stringify(urls) + ";",
  'self.addEventListener("install", (event) => {',
  "  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)));",
  "});",
  'self.addEventListener("activate", (event) => {',
  "  event.waitUntil((async () => {",
  "    for (const key of await caches.keys()) {",
  '      if (key.startsWith("iatron-offline-") && key !== CACHE) await caches.delete(key);',
  "    }",
  "    await self.clients.claim();",
  "  })());",
  "});",
  'self.addEventListener("fetch", (event) => {',
  '  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;',
  "  event.respondWith((async () => {",
  "    const cache = await caches.open(CACHE);",
  "    const cached = await cache.match(event.request, { ignoreSearch: true });",
  "    if (cached) return cached;",
  '    if (event.request.mode === "navigate") {',
  '      return await cache.match(new URL("./index.html", self.location.href)) || fetch(event.request);',
  "    }",
  "    return fetch(event.request);",
  "  })());",
  "});",
  "",
].join("\n");
await writeFile(new URL("sw.js", output), worker);
console.log(
  "Prepared offline cache for " + files.length + " local files in " + fileURLToPath(output),
);
