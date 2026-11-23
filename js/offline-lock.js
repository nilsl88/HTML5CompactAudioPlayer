// An IndexedDB upgrade waits for every older connection to close. The tab
// that upgraded keeps its connection open until its cache writes finish.
async function withDatabaseLock(name, action, whenBusy, signal) {
  let version;
  for (;;) {
    if (signal?.aborted) throw signal.reason;
    let upgraded = false;
    let skipped = false;
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open(name, version);
      const busy = () => { skipped = true; resolve(null); };
      // An open queued behind another tab's upgrade may never receive onblocked.
      const timeout = whenBusy ? setTimeout(busy, 1000) : null;
      request.onupgradeneeded = () => {
        if (skipped || signal?.aborted) request.transaction.abort();
        else upgraded = true;
      };
      request.onblocked = () => {
        if (whenBusy) { clearTimeout(timeout); busy(); }
      };
      request.onsuccess = () => {
        clearTimeout(timeout);
        if (signal?.aborted) {
          request.result.close();
          reject(signal.reason);
        } else if (skipped) request.result.close();
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

function requestOfflineLock(navigatorObject, name, action, whenBusy, signal) {
  if (navigatorObject.locks?.request) {
    const options = signal && !whenBusy ? { signal } : { ifAvailable: Boolean(whenBusy) };
    return navigatorObject.locks.request(name, options, (lock) => lock ? action() : whenBusy());
  }
  return withDatabaseLock(name, action, whenBusy, signal);
}

export async function withOfflineLock(navigatorObject, name, action, whenBusy, waitMs) {
  if (waitMs === undefined) return requestOfflineLock(navigatorObject, name, action, whenBusy);
  const controller = new AbortController();
  const { signal } = controller;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new DOMException("Waiting for the offline write lock timed out.", "TimeoutError");
      reject(error);
      controller.abort(error);
    }, waitMs);
  });
  const run = () => {
    clearTimeout(timer);
    if (signal.aborted) throw signal.reason;
    return action();
  };
  try {
    return await Promise.race([deadline, requestOfflineLock(navigatorObject, name, run, whenBusy, signal)]);
  } finally {
    clearTimeout(timer);
  }
}
