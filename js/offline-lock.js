// An IndexedDB upgrade waits for every older connection to close. The tab
// that upgraded keeps its connection open until its cache writes finish.
async function withDatabaseLock(name, action, whenBusy) {
  let version;
  for (;;) {
    let upgraded = false;
    let skipped = false;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      const busy = () => { skipped = true; resolve(null); };
      // An open queued behind another tab's upgrade may never receive onblocked.
      const timeout = whenBusy ? setTimeout(busy, 1000) : null;
      request.onupgradeneeded = () => {
        if (skipped) request.transaction.abort();
        else upgraded = true;
      };
      request.onblocked = () => {
        if (whenBusy) { clearTimeout(timeout); busy(); }
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (skipped) request.result.close();
        else resolve(request.result);
      };
      request.onerror = () => {
        clearTimeout(timeout);
        // A competing tab may already have advanced past the requested version.
        if (request.error.name === "VersionError") resolve(undefined);
        else reject(request.error);
      };
    });
    if (skipped) return whenBusy();
    if (!db) { version = undefined; continue; }
    try {
      if (upgraded) return await action();
      version = db.version + 1;
    } finally { db.close(); }
  }
}

export function withOfflineLock(navigatorObject, name, action, whenBusy) {
  if (navigatorObject.locks?.request) {
    return navigatorObject.locks.request(name, { ifAvailable: Boolean(whenBusy) }, (lock) => lock ? action() : whenBusy());
  }
  return withDatabaseLock(name, action, whenBusy);
}
