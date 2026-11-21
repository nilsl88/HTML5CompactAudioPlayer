export class ProgressWriter {
  constructor(storage) {
    this.storage = storage;
    this.pending = null;
    this.timer = null;
    this.lastWrite = 0;
    this.stopped = false;
  }

  record(bookId, languageCode, position, seek = false) {
    if (this.stopped || !bookId) return;
    const updatedAt = Date.now();
    const resetId = this.storage.resetId();
    const elapsed = updatedAt - this.lastWrite;
    const flushNow = seek || elapsed >= 5000;
    const previousUpdate = flushNow ? undefined
      : this.pending?.previousUpdate ?? this.storage.progressTimestamp(bookId, resetId, languageCode);
    this.pending = { bookId, languageCode, position, updatedAt, previousUpdate, resetId };
    if (flushNow) this.flush();
    else if (this.timer === null) this.timer = setTimeout(() => this.flush(), 5000 - elapsed);
  }

  flush() {
    if (!this.pending) return;
    const { bookId, languageCode, position, ...update } = this.pending;
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
    this.lastWrite = Date.now();
    this.storage.setProgress(bookId, languageCode, position, update);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}
