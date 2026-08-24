export class ProviderRegistry {
  constructor() { this.adapters = new Map(); }

  register(adapter) {
    if (!adapter?.id) throw new Error('provider adapter id is required');
    if (this.adapters.has(adapter.id)) throw new Error(`provider already registered: ${adapter.id}`);
    this.adapters.set(adapter.id, adapter);
    return adapter;
  }

  get(id) {
    const key = String(id || '').trim().toLowerCase();
    const adapter = this.adapters.get(key);
    if (!adapter) throw new Error(`unknown provider: ${id}; expected one of ${this.ids().join(', ')}`);
    return adapter;
  }

  ids() { return [...this.adapters.keys()]; }
  describe() { return [...this.adapters.values()].map((a) => a.describe()); }
}
