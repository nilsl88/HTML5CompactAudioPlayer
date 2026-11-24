function createShellRelease({
  scopeUrl, withCacheDeadline, withShellNetworkDeadline, SHELL_VERSION, SHELL_RELEASE,
  SHELL_CACHE_PREFIX, RELEASE_CACHE_PREFIX, VERIFIED_RELEASE_CACHE_PREFIX, SHELL_CACHE,
  RELEASE_READY_URL, SHELL_NETWORK_WAIT_MS, SHELL_PAGE_MAX_BYTES, CACHE_FALLBACK_WAIT_MS,
  RELEASE_REBUILD_TIMEOUT_MS, SHELL_URLS, PLAYER_PAGES, RELEASE_ASSETS,
}) {
  let releaseRebuild;
  async function cachedShell(request, signal) {
    const shell = await caches.open(SHELL_CACHE);
    if (signal?.aborted) return null;
    if (request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname)) {
      if (SHELL_RELEASE) {
        const ready = (await shell.match(RELEASE_READY_URL))?.ok;
        if (signal?.aborted) return null;
        const page = ready && await shell.match(scopeUrl(SHELL_RELEASE.page));
        if (page?.ok) return page;
        const predecessor = await previousCompleteRelease(await caches.keys(), signal);
        if (!predecessor || signal?.aborted) return null;
        const id = predecessor.slice(VERIFIED_RELEASE_CACHE_PREFIX.length);
        return caches.match(scopeUrl(`release-${id}.html`), { cacheName: predecessor });
      }
      const installed = await shell.match(scopeUrl(`index.html?v=${SHELL_VERSION.slice(1)}`));
      if (installed || signal?.aborted) return installed;
      return shell.match(scopeUrl(`./?v=${SHELL_VERSION.slice(1)}`));
    }
    return shell.match(request);
  }

  function invalidReleaseAsset(url) {
    return new Error(`Release asset does not match its manifest: ${url}`);
  }

  function cancelResponseBody(stream) {
    void stream?.cancel().catch(() => { /* The response body may already have failed. */ });
  }

  async function readShellBytes(body, maxBytes, signal) {
    if (signal?.aborted) {
      cancelResponseBody(body);
      throw signal.reason;
    }
    if (!body) return new Uint8Array(0);
    const bytes = new Uint8Array(maxBytes);
    const reader = body.getReader();
    let offset = 0;
    let ended = false;
    const cancel = () => {
      if (ended) return;
      ended = true;
      cancelResponseBody(reader);
    };
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      while (!ended) {
        const { done, value } = await reader.read();
        if (signal?.aborted) throw signal.reason;
        ended = done;
        if (done) break;
        if (value.byteLength > bytes.length - offset) return null;
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      return bytes.subarray(0, offset);
    } finally {
      signal?.removeEventListener("abort", cancel);
      cancel();
      reader.releaseLock();
    }
  }

  function decodedShellResponse(response, bytes) {
    // Fetch exposes decoded bytes, even when the server sends a compressed response.
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("transfer-encoding");
    headers.set("content-length", String(bytes.byteLength));
    return new Response(bytes, { status: response.status, statusText: response.statusText, headers });
  }

  async function matchesReleaseBytes(bytes, asset) {
    if (bytes?.byteLength !== asset.bytes) return false;
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    return hex === asset.sha256;
  }

  function fetchVerifiedReleaseAsset(url, asset, parent) {
    return withShellNetworkDeadline(async (signal) => {
      const response = await fetch(url, { cache: "reload", redirect: "error", signal });
      if (response.status !== 200 || response.redirected) {
        cancelResponseBody(response.body);
        throw invalidReleaseAsset(url);
      }
      const bytes = await readShellBytes(response.body, asset.bytes, signal);
      if (!await matchesReleaseBytes(bytes, asset)) throw invalidReleaseAsset(url);
      return decodedShellResponse(response, bytes);
    }, parent);
  }

  async function readCache(operation) {
    try {
      return await withCacheDeadline(operation, CACHE_FALLBACK_WAIT_MS);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not read Cache Storage.", error);
      return null;
    }
  }

  function currentReleaseCache(url) {
    return readCache(async (signal) => {
      const shell = await caches.open(SHELL_CACHE);
      if (signal.aborted) return null;
      const ready = (await shell.match(RELEASE_READY_URL))?.ok === true;
      if (signal.aborted) return null;
      return { shell, ready, response: ready && url ? await shell.match(url) : null };
    });
  }

  async function populateRelease(shell, seed, signal) {
    for (const [url, asset] of RELEASE_ASSETS) {
      if (signal?.aborted) return;
      const response = seed?.url === url ? seed.response : await fetchVerifiedReleaseAsset(url, asset, signal);
      if (signal?.aborted) return;
      await shell.put(url, response);
    }
    if (!signal?.aborted) await shell.put(RELEASE_READY_URL, new Response(SHELL_RELEASE.id));
  }

  function rebuildRelease(shell, seedUrl, verified) {
    if (!releaseRebuild) {
      const seed = verified && { url: seedUrl, response: verified.clone() };
      releaseRebuild = withCacheDeadline(async (signal) => {
        const ready = (await shell.match(RELEASE_READY_URL))?.ok;
        if (!ready && !signal.aborted) await populateRelease(shell, seed, signal);
      }, RELEASE_REBUILD_TIMEOUT_MS).catch((error) => {
        console.warn("[CompactAudioPlayer] Could not rebuild the release cache.", error);
      }).finally(() => { releaseRebuild = null; });
    }
    return releaseRebuild;
  }

  async function releaseAsset(request, url, asset, keepAlive) {
    const installed = await currentReleaseCache(url);
    if (installed?.response) return installed.response;
    const verified = await fetchVerifiedReleaseAsset(url, asset, request.signal);
    if (installed?.ready) {
      try {
        await withCacheDeadline(() => installed.shell.put(url, verified.clone()), CACHE_FALLBACK_WAIT_MS);
      } catch (error) {
        console.warn("[CompactAudioPlayer] Could not restore the release asset in Cache Storage.", error);
      }
    } else if (installed && keepAlive) {
      keepAlive(rebuildRelease(installed.shell, url, verified));
    }
    return verified;
  }

  function releaseRequest(request) {
    if (!SHELL_RELEASE || request.method !== "GET" || !request.url.startsWith(self.registration.scope)) return null;
    const relative = request.url.slice(self.registration.scope.length);
    const alias = request.mode === "navigate" && /^release-([a-f0-9]{64})\.html(?:\?.*)?$/.exec(relative);
    if (alias) return { id: alias[1], url: scopeUrl(`release-${alias[1]}.html`) };
    const asset = /^releases\/([a-f0-9]{64})\//.exec(relative);
    return asset ? { id: asset[1], url: request.url } : null;
  }

  function isReleaseCache(name, prefix) {
    return name.startsWith(prefix) && /^[a-f0-9]{64}$/.test(name.slice(prefix.length));
  }

  async function isCompleteRelease(cacheName) {
    return (await caches.match(RELEASE_READY_URL, { cacheName }))?.ok === true;
  }

  async function previousReleaseAsset(release, signal) {
    const cacheName = VERIFIED_RELEASE_CACHE_PREFIX + release.id;
    if (await isCompleteRelease(cacheName) && !signal.aborted) {
      const response = await caches.match(release.url, { cacheName });
      if (response) return response;
    }
    return signal.aborted ? null : caches.match(release.url, { cacheName: RELEASE_CACHE_PREFIX + release.id });
  }

  function validShellPage(html, allowNewer) {
    html = html.replace(/<!--[\s\S]*?-->/g, "");
    const attributeValue = (tag, attribute) => {
      const match = tag.match(new RegExp(`\\s${attribute}\\s*=\\s*(["'])(.*?)\\1`, "i"));
      return match?.[2];
    };
    const scripts = html.match(/<script\b[^>]*>/gi) || [];
    const links = html.match(/<link\b[^>]*>/gi) || [];
    if (allowNewer) {
      const worker = html.match(/<meta name="compact-player-worker" content="sw-([a-f0-9]{64})\.js">/)?.[1];
      if (worker) {
        const sequence = Number(html.match(/<meta name="compact-player-release" content="(\d+)">/)?.[1]);
        if (!Number.isSafeInteger(sequence) || sequence < (SHELL_RELEASE?.sequence || 0)) return false;
        const base = `./releases/${worker}/`;
        return scripts.some((tag) => attributeValue(tag, "type") === "module" && attributeValue(tag, "src") === `${base}player.js`)
          && links.some((tag) => attributeValue(tag, "rel") === "stylesheet" && attributeValue(tag, "href") === `${base}player.css`);
      }
      if (SHELL_RELEASE) return false;
    }
    const scriptVersions = scripts.filter((tag) => attributeValue(tag, "type") === "module")
      .map((tag) => attributeValue(tag, "src")?.match(/^\.\/player\.js\?v=(\d+)$/)?.[1]);
    const styleVersions = links.filter((tag) => attributeValue(tag, "rel") === "stylesheet")
      .map((tag) => attributeValue(tag, "href")?.match(/^\.\/player\.css\?v=(\d+)$/)?.[1]);
    const current = Number(SHELL_VERSION.slice(1));
    return scriptVersions.some((version) => version && styleVersions.includes(version)
      && (allowNewer ? Number(version) >= current : Number(version) === current));
  }

  async function readShellPage(response, allowNewer, signal) {
    if (!response?.ok) return null;
    const bytes = await readShellBytes(response.body, SHELL_PAGE_MAX_BYTES, signal);
    if (!bytes || !validShellPage(new TextDecoder().decode(bytes), allowNewer)) return null;
    return { bytes, response: decodedShellResponse(response, bytes) };
  }

  async function rebuildFromPage(bytes) {
    try {
      const url = scopeUrl(SHELL_RELEASE.page);
      if (!await matchesReleaseBytes(bytes, RELEASE_ASSETS.get(url))) return;
      const installed = await currentReleaseCache();
      if (installed && !installed.ready) await rebuildRelease(installed.shell);
    } catch (error) {
      console.warn("[CompactAudioPlayer] Could not check the player page for cache recovery.", error);
    }
  }

  async function fetchShell(request, keepAlive) {
    const controller = new AbortController();
    const isPage = request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname);
    const network = withShellNetworkDeadline(async (signal) => {
      const response = await fetch(request, { signal });
      if (signal.aborted) {
        cancelResponseBody(response.body);
        throw signal.reason;
      }
      if (!isPage || !response.ok) return response;
      const page = await readShellPage(response, true, signal);
      if (page) {
        if (!signal.aborted && SHELL_RELEASE && keepAlive) keepAlive(rebuildFromPage(page.bytes));
        return page.response;
      }
      throw new Error("Player shell version does not match the worker");
    }, request.signal, controller);
    let timer;
    try {
      const deadline = new Promise((resolve) => { timer = setTimeout(resolve, SHELL_NETWORK_WAIT_MS); });
      const response = await Promise.race([network, deadline]);
      if (response) return response;
      // Keep the network in the race while Cache Storage opens, including on a cache miss.
      const cached = await Promise.race([network.then(() => null), readCache((signal) => cachedShell(request, signal))]);
      if (!cached?.ok) return network;
      controller.abort();
      return cached;
    } finally { clearTimeout(timer); }
  }

  async function installRelease() {
    if (await isCompleteRelease(SHELL_CACHE)) return;
    try {
      await populateRelease(await caches.open(SHELL_CACHE));
    } catch (error) {
      try { await caches.delete(SHELL_CACHE); }
      catch (cause) { console.warn("[CompactAudioPlayer] Could not remove the incomplete release cache.", cause); }
      throw error;
    }
  }

  async function installSourceShell() {
    const stagingName = `${SHELL_CACHE}:install:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    const staging = await caches.open(stagingName);
    try {
      await staging.addAll(SHELL_URLS.map((path) => new Request(scopeUrl(path), { cache: "reload" })));
      for (const page of [`./?v=${SHELL_VERSION.slice(1)}`, `./index.html?v=${SHELL_VERSION.slice(1)}`]) {
        if (!await readShellPage(await staging.match(scopeUrl(page)), false)) throw new Error("Player shell version does not match the worker");
      }
      const cache = await caches.open(SHELL_CACHE);
      for (const request of await staging.keys()) await cache.put(request, await staging.match(request));
    } finally {
      await caches.delete(stagingName);
    }
  }

  async function previousCompleteRelease(names, signal) {
    for (const name of names.slice().reverse()) {
      if (signal?.aborted) return null;
      if (name !== SHELL_CACHE && isReleaseCache(name, VERIFIED_RELEASE_CACHE_PREFIX) && await isCompleteRelease(name)) return name;
    }
    return null;
  }

  async function cleanUpShellCaches(signal) {
    const names = await caches.keys();
    if (signal.aborted) return;
    const previousRelease = SHELL_RELEASE && await previousCompleteRelease(names, signal);
    if (signal.aborted) return;
    // Older release caches have no marker. Keep them until we can retain a known complete predecessor instead.
    const obsolete = names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE
      && name !== previousRelease && !name.includes(":install:")
      && (!SHELL_RELEASE || previousRelease || !isReleaseCache(name, RELEASE_CACHE_PREFIX)));
    await Promise.all(obsolete.map((name) => caches.delete(name)));
  }

    return { cancelResponseBody, cachedShell, invalidReleaseAsset, readShellBytes, decodedShellResponse, matchesReleaseBytes, fetchVerifiedReleaseAsset, readCache, currentReleaseCache, populateRelease, rebuildRelease, releaseAsset, releaseRequest, isReleaseCache, isCompleteRelease, previousReleaseAsset, validShellPage, readShellPage, rebuildFromPage, fetchShell, installRelease, installSourceShell, previousCompleteRelease, cleanUpShellCaches };
}
