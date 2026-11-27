import { BookConfigStore, fetchLibraryCatalog, queryBookId } from "./book-config.js?v=25";
import { normalizeLibrary } from "./config.js?v=25";

export class BookSession {
  constructor({ baseUrl, fetchImpl, isOnline, waitForOffline, readDownload, searchParams, lastBookId, view = {} } = {}) {
    Object.assign(this, { baseUrl, fetchImpl, isOnline, waitForOffline, readDownload, searchParams, lastBookId, view });
    this.library = normalizeLibrary(null);
    this.libraryUrl = baseUrl && new URL("media/library.json", baseUrl).href;
    this.catalogController = new AbortController();
    this.libraryNeedsRetry = false;
    this.configs = null;
    this.current = null;
    this.requestedId = "";
    this.startupRequest = null;
    this.generation = 0;
    this.controller = null;
    this.refreshController = null;
    this.selectionSettled = null;
    this.resolveSelection = null;
    this.pendingConfig = null;
    this.recovery = null;
    this.recoveryQueued = false;
  }

  begin() {
    this.controller?.abort();
    this.refreshController?.abort();
    this.resolveSelection?.();
    this.controller = new AbortController();
    this.selectionSettled = new Promise((resolve) => { this.resolveSelection = resolve; });
    this.generation++;
    return { generation: this.generation, signal: this.controller.signal };
  }

  isCurrent(generation) {
    return generation === this.generation;
  }

  async load(configs, id, request, online) {
    const loaded = await configs.load(id, { signal: request.signal, revalidate: online });
    return this.isCurrent(request.generation) ? loaded : null;
  }

  finish(generation) {
    if (!this.isCurrent(generation)) return false;
    this.controller = null;
    this.resolveSelection?.();
    this.resolveSelection = null;
    this.selectionSettled = null;
    return true;
  }

  invalidate() {
    this.catalogController.abort();
    this.configs?.close();
    this.controller?.abort();
    this.refreshController?.abort();
    this.finish(this.generation);
    this.generation++;
    this.pendingConfig = null;
    this.recoveryQueued = false;
  }

  async waitForSelection() {
    while (this.selectionSettled) await this.selectionSettled;
  }

  get closed() { return this.catalogController.signal.aborted; }

  async readCatalog() {
    try { return await fetchLibraryCatalog(this.libraryUrl, this.fetchImpl, this.catalogController.signal); }
    catch (error) {
      if (!this.closed && error?.name !== "AbortError") this.view.onError?.("library load", error);
      return null;
    }
  }

  async start() {
    const startedOffline = !this.isOnline();
    if (startedOffline) await this.waitForOffline();
    if (this.closed) return;
    const catalog = await this.readCatalog();
    const wasOffline = startedOffline || !this.isOnline();
    if (!this.isOnline()) await this.waitForOffline();
    if (this.closed) return;
    this.libraryNeedsRetry = !catalog || catalog.fromDownload;
    this.library = catalog?.library || this.library;
    const download = this.isOnline() ? null : this.readDownload();
    this.configs = new BookConfigStore({ library: this.library, documentBaseUrl: this.baseUrl,
      downloadedConfig: download?.config, fetchImpl: this.fetchImpl });
    this.startupRequest = this.selectInitial(download?.id);
    if (this.view.titlesVisible?.()) void this.loadTitles();
    if (wasOffline && this.isOnline()) void this.recover();
    await this.startupRequest;
  }

  async selectInitial(downloadedId) {
    const queryId = queryBookId(this.searchParams(), this.library);
    const savedId = this.lastBookId();
    const id = downloadedId || queryId || (this.library.byId.has(savedId) ? savedId : "")
      || this.library.defaultId || "episode-001";
    try { await this.select(id); }
    catch (error) { this.view.onStartupError?.(error); }
  }

  async select(id) {
    if (this.closed || !this.configs) return;
    const request = this.begin();
    const first = !this.current;
    this.requestedId = id;
    try {
      this.view.onRequested?.({ first });
      const loaded = await this.load(this.configs, id, request, this.isOnline());
      if (loaded) this.publish(id, loaded, { first });
    } catch (error) {
      if (!this.isCurrent(request.generation)) return;
      this.requestedId = this.current?.id || id;
      this.view.onFailed?.({ first });
      throw error;
    } finally {
      if (this.finish(request.generation)) this.view.onSettled?.();
    }
  }

  publish(id, loaded, change) {
    const previous = this.current;
    this.current = { ...loaded, id };
    try { this.view.onLoaded?.(this.current, change); }
    catch (error) { this.current = previous; throw error; }
    this.pendingConfig = null;
  }

  loadTitles() {
    if (this.closed || this.library.books.length <= 1 || !this.isOnline()) return;
    return this.configs.loadTitles((id, error) => this.view.onError?.(`library title (${id})`, error),
      (record) => this.view.onTitle?.(record));
  }

  recover({ reconnected = false } = {}) {
    if (this.closed || !this.configs || !this.isOnline()) return;
    if (this.recovery) {
      this.recoveryQueued ||= reconnected;
      return this.recovery;
    }
    this.recovery = Promise.resolve().then(async () => {
      try {
        do {
          this.recoveryQueued = false;
          await this.recoverSelection();
        } while (this.recoveryQueued);
      } finally {
        this.recovery = null;
      }
    });
    return this.recovery;
  }

  async recoverSelection() {
    if (this.closed || !this.isOnline()) return;
    const generation = this.generation;
    if (this.libraryNeedsRetry) {
      const catalog = await this.readCatalog();
      if (this.closed) return;
      if (catalog) {
        this.libraryNeedsRetry = catalog.fromDownload;
        this.library = catalog.library;
        this.configs.setLibrary(this.library, { fromDownload: catalog.fromDownload });
        this.view.onCatalog?.({ waitingForFirstBook: !this.current && Boolean(this.controller) });
      } else if (!this.current && !this.controller) return;
    } else if (this.configs.downloadedConfig) this.configs.setLibrary(this.library);
    if (this.view.titlesVisible?.()) void this.loadTitles();
    await this.startupRequest;
    await this.waitForSelection();
    if (this.closed || !this.isOnline()) return;
    const current = this.current;
    if (!current) {
      if (this.isCurrent(generation)) await this.selectInitial();
      return;
    }
    const currentGeneration = this.generation;
    const controller = new AbortController();
    this.refreshController = controller;
    try {
      const refreshed = await this.configs.load(current.id, { signal: controller.signal, revalidate: true });
      if (controller.signal.aborted || !this.isCurrent(currentGeneration) || !this.isOnline()) return;
      this.stageRefresh(refreshed, current.book, current.configUrl);
      const record = this.library.byId.get(current.id);
      if (record) this.view.onTitle?.(record);
    } catch (error) {
      if (!controller.signal.aborted) this.view.onError?.("book configuration refresh", error);
    } finally {
      if (this.refreshController === controller) this.refreshController = null;
    }
  }

  applyRefresh(playing) {
    const refreshed = this.takePending({ playing, online: this.isOnline(), resetting: this.closed });
    if (refreshed) this.publish(this.current.id, refreshed, { refresh: true });
  }

  stageRefresh(config, book, configUrl) {
    if (!config.fromDownload && (config.book !== book || config.configUrl !== configUrl)) this.pendingConfig = config;
  }

  takePending({ playing = false, online = true, resetting = false } = {}) {
    if (playing || !online || resetting || this.controller) return null;
    const config = this.pendingConfig;
    this.pendingConfig = null;
    return config;
  }
}
