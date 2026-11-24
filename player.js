import { startPlayer } from "./js/player-app.js?v=22";
import { PlayerStorage } from "./js/storage.js?v=22";

void startPlayer({ window, storage: PlayerStorage.fromBrowser(window), fetchImpl: window.fetch.bind(window) });
