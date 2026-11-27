function createShellRelease({
  scopeUrl, readCache, withCacheDeadline, withShellNetworkDeadline, preferNetwork, SHELL_VERSION, SHELL_RELEASE,
  SHELL_CACHE_PREFIX, RELEASE_CACHE_PREFIX, VERIFIED_RELEASE_CACHE_PREFIX, SHELL_CACHE,
  RELEASE_READY_URL, SHELL_PAGE_MAX_BYTES, CACHE_FALLBACK_WAIT_MS,
  RELEASE_REBUILD_TIMEOUT_MS, SHELL_URLS, PLAYER_PAGES, RELEASE_ASSETS,
}) {
  const { cancelResponseBody, readResponseBytes, responseWithDecodedBody } = globalThis.CompactPlayerResponse;
  let releaseRebuild;
  async function matchResponse(lookup, signal) {
    const response = await lookup();
    if (!signal?.aborted) return response;
    cancelResponseBody(response?.body);
    return null;
  }

  async function hasCachedFiles(cache, urls, signal) {
    try {
      const installed = new Set((await cache.keys()).map((entry) => entry.url));
      return !signal?.aborted && [...urls].every((url) => installed.has(url));
    } catch (error) {
      if (!signal?.aborted) console.warn("[CompactAudioPlayer] Could not list the cached release files.", error);
      return false;
    }
  }

  async function cachedReleasePage(shell, signal) {
    const ready = (await shell.match(RELEASE_READY_URL))?.ok;
    if (signal?.aborted) return null;
    const page = ready ? await matchResponse(() => shell.match(scopeUrl(SHELL_RELEASE.page)), signal) : null;
    if (page?.ok && await hasCachedFiles(shell, RELEASE_ASSETS.keys(), signal)) return page;
    const predecessor = signal?.aborted ? null : await previousCompleteRelease(await caches.keys(), signal);
    if (signal?.aborted || predecessor) cancelResponseBody(page?.body);
    if (signal?.aborted) return null;
    return predecessor?.page ?? page;
  }

  async function cachedShell(request, signal) {
    const shell = await caches.open(SHELL_CACHE);
    if (signal?.aborted) return null;
    if (request.mode === "navigate" && PLAYER_PAGES.has(new URL(request.url).pathname)) {
      if (SHELL_RELEASE) return cachedReleasePage(shell, signal);
      const installed = await matchResponse(() => shell.match(scopeUrl(`index.html?v=${SHELL_VERSION.slice(1)}`)), signal);
      if (installed || signal?.aborted) return installed;
      return matchResponse(() => shell.match(scopeUrl(`./?v=${SHELL_VERSION.slice(1)}`)), signal);
    }
    return matchResponse(() => shell.match(request), signal);
  }

  function invalidReleaseAsset(url) {
    return new Error(`Release asset does not match its manifest: ${url}`);
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
      const bytes = await readResponseBytes(response.body, asset.bytes, signal);
      if (!await matchesReleaseBytes(bytes, asset)) throw invalidReleaseAsset(url);
      return responseWithDecodedBody(response, bytes);
    }, parent);
  }

  function currentReleaseCache(url, parent) {
    return readCache(async (signal) => {
      const shell = await caches.open(SHELL_CACHE);
      if (signal.aborted) return null;
      const ready = (await shell.match(RELEASE_READY_URL))?.ok === true;
      if (signal.aborted) return null;
      const response = ready && url ? await matchResponse(() => shell.match(url), signal) : null;
      return signal.aborted ? null : { shell, ready, response };
    }, { parent });
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
    const installed = await currentReleaseCache(url, request.signal);
    if (request.signal.aborted) {
      cancelResponseBody(installed?.response?.body);
      throw request.signal.reason;
    }
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
    const marker = await caches.match(RELEASE_READY_URL, { cacheName });
    cancelResponseBody(marker?.body);
    return marker?.ok === true;
  }

  async function previousReleaseAsset(release, signal) {
    const cacheName = VERIFIED_RELEASE_CACHE_PREFIX + release.id;
    if (await isCompleteRelease(cacheName) && !signal.aborted) {
      const response = await matchResponse(() => caches.match(release.url, { cacheName }), signal);
      if (response) return response;
    }
    return signal.aborted ? null : matchResponse(() => caches.match(release.url, { cacheName: RELEASE_CACHE_PREFIX + release.id }), signal);
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
    const bytes = await readResponseBytes(response.body, SHELL_PAGE_MAX_BYTES, signal);
    if (!bytes || !validShellPage(new TextDecoder().decode(bytes), allowNewer)) return null;
    return { bytes, response: responseWithDecodedBody(response, bytes) };
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
    return preferNetwork(network, (signal) => cachedShell(request, signal), () => controller.abort());
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

  function predecessorFiles(bytes, id) {
    const html = new TextDecoder().decode(bytes);
    const importMap = html.match(/<script type="importmap">([^<]+)<\/script>/)?.[1];
    if (!importMap) return null;
    const base = `./releases/${id}/`;
    try {
      const modules = Object.keys(JSON.parse(importMap).integrity ?? {});
      if (!modules.includes(base + "player.js") || modules.some((path) => !path.startsWith(base))) return null;
      return [...modules, base + "player.css"].map(scopeUrl);
    } catch {
      // The verified release page declares its modules in the generated import map.
      return null;
    }
  }

  async function previousCompleteRelease(names, signal) {
    for (const name of names.slice().reverse()) {
      if (signal?.aborted) return null;
      if (name === SHELL_CACHE || !isReleaseCache(name, VERIFIED_RELEASE_CACHE_PREFIX) || !await isCompleteRelease(name)) continue;
      if (signal?.aborted) return null;
      const id = name.slice(VERIFIED_RELEASE_CACHE_PREFIX.length);
      const url = scopeUrl(`release-${id}.html`);
      const page = await matchResponse(() => caches.match(url, { cacheName: name }), signal);
      if (!page?.ok) {
        cancelResponseBody(page?.body);
        continue;
      }
      const bytes = await readResponseBytes(page.body, SHELL_PAGE_MAX_BYTES, signal);
      const files = bytes && predecessorFiles(bytes, id);
      if (!files || signal?.aborted) continue;
      const cache = await caches.open(name);
      if (await hasCachedFiles(cache, files, signal)) return { name, page: responseWithDecodedBody(page, bytes) };
    }
    return null;
  }

  async function cleanUpShellCaches(signal) {
    const names = await caches.keys();
    if (signal.aborted) return;
    const previous = SHELL_RELEASE && await previousCompleteRelease(names, signal);
    cancelResponseBody(previous?.page.body);
    const previousRelease = previous?.name;
    if (signal.aborted) return;
    // Older release caches have no marker. Keep them until we can retain a known complete predecessor instead.
    const obsolete = names.filter((name) => name.startsWith(SHELL_CACHE_PREFIX) && name !== SHELL_CACHE
      && name !== previousRelease && !name.includes(":install:")
      && (!SHELL_RELEASE || previousRelease || !isReleaseCache(name, RELEASE_CACHE_PREFIX)));
    await Promise.all(obsolete.map((name) => caches.delete(name)));
  }

  return { cachedShell, releaseAsset, releaseRequest, previousReleaseAsset, fetchShell,
    installRelease, installSourceShell, cleanUpShellCaches };
}
