import { startPlayer } from "./js/player-app.js?v=25";
import { PlayerStorage } from "./js/storage.js?v=25";

void startPlayer({ window, storage: PlayerStorage.fromBrowser(window), fetchImpl: window.fetch.bind(window) });
