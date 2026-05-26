import { STARTING_ZONE_ID } from "../shared/constants.js";
import { loadSpeciesData } from "../shared/species.js";
import { createApp } from "./app.js";
import { loadSpecies, loadZone } from "./data.js";
import { installMemoryBackend } from "./memoryBackend.js";

const PORT = Number(process.env.PORT) || 8090;
const HOST = process.env.HOST || "127.0.0.1";

installMemoryBackend();

const speciesRaw = await loadSpecies();
loadSpeciesData(speciesRaw);
const startingRaw = await loadZone(STARTING_ZONE_ID);
const { httpServer, instance } = createApp({ rawZone: startingRaw });
console.log(
  `loaded zone ${instance.zone.id} (${instance.zone.rows}x${instance.zone.cols}, ` +
  `${instance.zone.entities.length} entities)`
);

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
