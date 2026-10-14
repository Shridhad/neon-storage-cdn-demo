import { beforeEach } from 'vitest';

// Node has no Cache API; a Map-backed stand-in with the same match/put surface keeps list caching testable.
const store = new Map();
globalThis.caches = {
  default: {
    async match(req) {
      return store.get(req.url)?.clone();
    },
    async put(req, res) {
      store.set(req.url, res.clone());
    },
  },
};

beforeEach(() => store.clear());
