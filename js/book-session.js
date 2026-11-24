export class BookSession {
  constructor() {
    this.generation = 0;
    this.controller = null;
    this.pendingConfig = null;
  }

  begin() {
    this.controller?.abort();
    this.controller = new AbortController();
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
    return true;
  }

  invalidate() {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.pendingConfig = null;
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
