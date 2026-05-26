import { createServer } from "node:http";

import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { buildZone } from "../shared/zone.js";
import { loadSpecies, loadZone } from "./data.js";
import { installMemoryBackend } from "./memoryBackend.js";

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || "127.0.0.1";

installMemoryBackend();

// Load the starting zone once at boot. buildZone needs species loaded first
// (zone.js looks up entity types via getSpecies). When parties land later
// every (zoneId, partyId) instance will clone from the cached raw JSON.
const speciesRaw = await loadSpecies();
loadSpeciesData(speciesRaw);
const startingRaw = await loadZone(STARTING_ZONE_ID);
const startingZone = buildZone(startingRaw);
console.log(
  `loaded zone ${startingZone.id} (${startingZone.rows}x${startingZone.cols}, ` +
  `${startingZone.entities.length} entities)`
);

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("ok\n");
    return;
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("hello from sneakbit server\n");
    return;
  }
  res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  res.end("not found\n");
});

server.listen(PORT, HOST, () => {
  console.log(`sneakbit server listening on http://${HOST}:${PORT}`);
});

const shutdown = (signal) => {
  console.log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
