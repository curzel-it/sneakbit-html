import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { createApp } from "./app.js";
import { loadSpecies, loadZone } from "./data.js";
import { installMemoryBackend } from "./memoryBackend.js";
import { installServerCombatHealth } from "./combatHealthBackend.js";
import { installServerInventoryBackend } from "./inventoryBackend.js";
import { installServerPickupHandlers } from "./pickupHandlers.js";

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || "127.0.0.1";

installMemoryBackend();
installServerCombatHealth();
installServerInventoryBackend();
installServerPickupHandlers();

const speciesRaw = await loadSpecies();
loadSpeciesData(speciesRaw);

// Preload the starting zone so the first connect doesn't pay disk I/O.
await loadZone(STARTING_ZONE_ID);

const { httpServer } = createApp({
  loadRawZone: (zoneId) => loadZone(zoneId),
  startingZoneId: STARTING_ZONE_ID,
});
console.log(`sneakbit server ready (starting zone ${STARTING_ZONE_ID})`);

httpServer.listen(PORT, HOST, () => {
  console.log(`sneakbit server listening on http://${HOST}:${PORT} (ws on /ws)`);
});

const shutdown = (signal) => {
  console.log(`received ${signal}, shutting down`);
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
