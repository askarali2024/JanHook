'use strict';

/**
 * JanHook JSON store.
 *
 * Everything lives in DATA_DIR:
 *   endpoints.json        — list of webhook endpoints + their response config
 *   requests-<slug>.json  — captured requests for one endpoint (newest first,
 *                           auto-pruned to MAX_REQUESTS_PER_BIN entries)
 *
 * Writes are atomic (tmp file + rename) and debounced per endpoint so a burst
 * of webhooks doesn't hammer the disk.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Lowercase, visually unambiguous alphabet (no 0/o, 1/l/i confusion).
const SLUG_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function genSlug(length = 10) {
  const bytes = crypto.randomBytes(length);
  let slug = '';
  for (const b of bytes) slug += SLUG_ALPHABET[b % SLUG_ALPHABET.length];
  return slug;
}

class Store {
  constructor(dataDir, maxPerBin) {
    this.dataDir = dataDir;
    this.maxPerBin = Math.max(1, maxPerBin || 100);

    fs.mkdirSync(this.dataDir, { recursive: true });

    this.endpointsFile = path.join(this.dataDir, 'endpoints.json');
    this.endpoints = this.#readJson(this.endpointsFile, []);
    if (!Array.isArray(this.endpoints)) this.endpoints = [];

    this.bins = new Map(); // slug -> { requests: [], timer: null }
  }

  // ---------- internal helpers ----------

  #readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  #writeJson(file, data) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  }

  #saveEndpoints() {
    this.#writeJson(this.endpointsFile, this.endpoints);
  }

  #requestsFile(slug) {
    return path.join(this.dataDir, `requests-${slug}.json`);
  }

  #bin(slug) {
    let bin = this.bins.get(slug);
    if (!bin) {
      let requests = this.#readJson(this.#requestsFile(slug), []);
      if (!Array.isArray(requests)) requests = [];
      // Drop corrupt entries and re-apply the retention cap (in case the
      // setting was lowered since the file was written).
      requests = requests
        .filter((r) => r && typeof r.id === 'string' && typeof r.receivedAt === 'string')
        .slice(0, this.maxPerBin);
      bin = { requests, timer: null };
      this.bins.set(slug, bin);
    }
    return bin;
  }

  #scheduleFlush(slug) {
    const bin = this.#bin(slug);
    if (bin.timer) return;
    bin.timer = setTimeout(() => {
      bin.timer = null;
      try {
        this.#writeJson(this.#requestsFile(slug), bin.requests);
      } catch (err) {
        console.error('[janhook] failed to persist requests for %s: %s', slug, err.message);
      }
    }, 250);
  }

  // ---------- endpoints ----------

  listEndpoints() {
    return this.endpoints.map((e) => ({ ...e }));
  }

  getEndpoint(slug) {
    const ep = this.endpoints.find((e) => e.slug === slug);
    return ep ? { ...ep } : null;
  }

  createEndpoint(name) {
    let slug;
    do {
      slug = genSlug();
    } while (this.endpoints.some((e) => e.slug === slug));

    const endpoint = {
      slug,
      name: (typeof name === 'string' && name.trim()) || slug,
      createdAt: new Date().toISOString(),
      response: { status: 200, body: '{"ok":true}' },
    };
    this.endpoints.push(endpoint);
    this.#saveEndpoints();
    return { ...endpoint };
  }

  updateEndpoint(slug, patch) {
    const ep = this.endpoints.find((e) => e.slug === slug);
    if (!ep) return null;

    if (patch && patch.response) {
      const status = Number.parseInt(patch.response.status, 10);
      ep.response = {
        status: Number.isFinite(status) && status >= 100 && status <= 599 ? status : (ep.response?.status ?? 200),
        body:
          typeof patch.response.body === 'string'
            ? patch.response.body
            : (ep.response?.body ?? '{"ok":true}'),
      };
    }
    if (patch && typeof patch.name === 'string' && patch.name.trim()) {
      ep.name = patch.name.trim();
    }

    this.#saveEndpoints();
    return { ...ep };
  }

  deleteEndpoint(slug) {
    const idx = this.endpoints.findIndex((e) => e.slug === slug);
    if (idx === -1) return false;

    this.endpoints.splice(idx, 1);
    this.#saveEndpoints();

    const bin = this.bins.get(slug);
    if (bin && bin.timer) clearTimeout(bin.timer);
    this.bins.delete(slug);

    try {
      fs.unlinkSync(this.#requestsFile(slug));
    } catch {
      /* file may not exist — fine */
    }
    return true;
  }

  // ---------- captured requests ----------

  getRequests(slug) {
    return this.#bin(slug).requests.map((r) => ({ ...r }));
  }

  addRequest(slug, request) {
    const bin = this.#bin(slug);
    bin.requests.unshift(request);
    if (bin.requests.length > this.maxPerBin) {
      bin.requests.length = this.maxPerBin; // drop the oldest
    }
    this.#scheduleFlush(slug);
    return request;
  }

  clearRequests(slug) {
    const bin = this.#bin(slug);
    bin.requests = [];
    if (bin.timer) {
      clearTimeout(bin.timer);
      bin.timer = null;
    }
    this.#writeJson(this.#requestsFile(slug), []);
  }

  deleteRequest(slug, id) {
    const bin = this.#bin(slug);
    const idx = bin.requests.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    bin.requests.splice(idx, 1);
    this.#scheduleFlush(slug);
    return true;
  }

  // Side-effect free lookup (does not create an in-memory bin).
  findRequest(slug, id) {
    const bin = this.bins.get(slug);
    const list = Array.isArray(bin?.requests)
      ? bin.requests
      : this.#readJson(this.#requestsFile(slug), []);
    if (!Array.isArray(list)) return null;
    return list.find((r) => r && r.id === id) || null;
  }

  // ---------- shutdown ----------

  flushAllSync() {
    for (const [slug, bin] of this.bins) {
      if (bin.timer) {
        clearTimeout(bin.timer);
        bin.timer = null;
      }
      try {
        this.#writeJson(this.#requestsFile(slug), bin.requests);
      } catch (err) {
        console.error('[janhook] failed to flush requests for %s: %s', slug, err.message);
      }
    }
  }
}

module.exports = Store;
