import { startPlayer } from "./js/player-app.js";
import { PlayerStorage } from "./js/storage.js";

void startPlayer({ window, storage: PlayerStorage.fromBrowser(window), fetchImpl: window.fetch.bind(window) });
