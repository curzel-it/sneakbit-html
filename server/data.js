// Server-side mirror of client/data.js. Uses fs.readFile against the repo's
// data/ directory instead of fetch(). Same API (loadZone / loadSpecies /
// loadStrings) so callers don't care which side they're on. Cached per id.

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, "..", "data");

const cache = new Map();

async function readJson(relative) {
  const buf = await readFile(join(DATA_DIR, relative), "utf-8");
  return JSON.parse(buf);
}

export async function loadZone(id) {
  const key = `zone:${id}`;
  if (cache.has(key)) return cache.get(key);
  const raw = await readJson(`${id}.json`);
  cache.set(key, raw);
  return raw;
}

export async function loadSpecies() {
  const key = "species";
  if (!cache.has(key)) cache.set(key, await readJson("species.json"));
  return cache.get(key);
}

export async function loadStrings(lang = "en") {
  const key = `strings:${lang}`;
  if (!cache.has(key)) cache.set(key, await readJson(`strings.${lang}.json`));
  return cache.get(key);
}
