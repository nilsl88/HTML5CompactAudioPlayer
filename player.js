import { startPlayer } from "./js/player-app.js?v=20";
import { PlayerStorage } from "./js/storage.js?v=20";

void startPlayer({ window, storage: PlayerStorage.fromBrowser(window), fetchImpl: window.fetch.bind(window) });
