// Local automated checks only. No generated temperature records; restart clears this store.
export class MemoryStore {
  data = new Map();
  counter = 0;
  async set(key, value, options = {}) {
    const previous = this.data.get(key);
    if ((options.onlyIfNew && previous) || (options.onlyIfMatch && previous?.etag !== options.onlyIfMatch)) return { modified: false };
    const etag = String(++this.counter);
    this.data.set(key, { value, etag });
    return { modified: true, etag };
  }
  async setJSON(key, value, options) { return this.set(key, JSON.stringify(value), options); }
  async get(key, options = {}) {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (options.type === 'json') return JSON.parse(entry.value);
    if (options.type === 'arrayBuffer') return Uint8Array.from(entry.value).buffer;
    return entry.value;
  }
  async getWithMetadata(key, options = {}) {
    const entry = this.data.get(key);
    return entry ? { data: await this.get(key, options), etag: entry.etag, metadata: {} } : null;
  }
  async getMetadata(key) {
    const entry = this.data.get(key);
    return entry ? { etag: entry.etag, metadata: {} } : null;
  }
  async delete(key) { this.data.delete(key); }
  async *list({ prefix = '', directories = false }) {
    const keys = [...this.data.keys()].filter(key => key.startsWith(prefix));
    const dirs = new Set(), blobs = [];
    for (const key of keys) {
      const remainder = key.slice(prefix.length);
      if (directories && remainder.includes('/')) dirs.add(prefix + remainder.split('/')[0]);
      else blobs.push({ key });
    }
    yield { blobs, directories: [...dirs] };
  }
}
