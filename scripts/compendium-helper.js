/**
 * CompendiumHelper
 *
 * Centralizes compendium access with index caching so adapters never
 * hammer the server with repeated metadata requests.
 *
 * Usage:
 *   const items = await CompendiumHelper.findByName("Cloak of Protection", packIds);
 *   const gems  = await CompendiumHelper.findByTypeAndValue("treasure", 50, packIds);
 *   const list  = await CompendiumHelper.findByLevelAndType(packIds, { level: 5, type: "consumable" });
 */

const _indexCache = new Map(); // packId → Collection
const _poolCache  = new Map(); // sorted-packIds key → flat item pool array

export const CompendiumHelper = {
  /**
   * Get (and cache) the index for a compendium pack.
   * Returns null if the pack does not exist in this world.
   *
   * @param {string} packId
   * @returns {Promise<Collection|null>}
   */
  async getIndex(packId) {
    if (_indexCache.has(packId)) return _indexCache.get(packId);

    const pack = game.packs.get(packId);
    if (!pack) return null;

    const index = await pack.getIndex({ fields: ["name", "type", "system.rarity", "system.price", "system.level", "img"] });
    _indexCache.set(packId, index);
    return index;
  },

  /** Clear cached indexes (e.g., after a compendium reload). */
  clearCache() {
    _indexCache.clear();
    _poolCache.clear();
  },

  /**
   * Build a flat item pool from multiple packs' indexes and cache it.
   * Subsequent calls for the same pack set return immediately from cache.
   *
   * @param {string[]} packIds
   * @returns {Promise<Array<{packId,id,name,type,rarity,img}>>}
   */
  async buildPool(packIds) {
    const key  = [...packIds].sort().join(",");
    const pool = [];

    for (const packId of packIds) {
      const index = await this.getIndex(packId);
      if (!index) continue;
      for (const entry of index) {
        if (entry.type === "spell") continue;
        pool.push({
          packId,
          id:     entry._id,
          name:   entry.name,
          type:   entry.type ?? "",
          rarity: (entry.system?.rarity ?? "common").toLowerCase().replace(/\s+/g, ""),
          img:    entry.img,
        });
      }
    }

    _poolCache.set(key, pool);
    console.log(`LootRoller | Item pool ready: ${pool.length} entries across ${packIds.length} pack(s)`);
    return pool;
  },

  /**
   * Return the cached pool for these packs, or null if not yet built.
   * @param {string[]} packIds
   * @returns {Array|null}
   */
  getPool(packIds) {
    return _poolCache.get([...packIds].sort().join(",")) ?? null;
  },

  /** Clear the item pool cache (call when pack selection changes). */
  clearPool() {
    _poolCache.clear();
  },

  /**
   * Search multiple packs for an item by exact name, falling back to
   * case-insensitive substring match if no exact hit is found.
   *
   * @param {string}   name
   * @param {string[]} packIds
   * @returns {Promise<Item|null>}
   */
  async findByName(name, packIds) {
    const nameLower = name.toLowerCase();

    for (const packId of packIds) {
      const index = await this.getIndex(packId);
      if (!index) continue;

      const entry = index.find((e) => e.name === name)
        ?? index.find((e) => e.name.toLowerCase() === nameLower)
        ?? index.find((e) => e.name.toLowerCase().includes(nameLower));

      if (entry) {
        const pack = game.packs.get(packId);
        return pack.getDocument(entry._id);
      }
    }
    return null;
  },

  /**
   * Find treasure-type items (gems, art objects) by their GP value.
   * Returns a random document from all matches across the supplied packs.
   *
   * @param {number}   gpValue
   * @param {string[]} packIds
   * @returns {Promise<Item|null>}
   */
  async findTreasureByValue(gpValue, packIds) {
    const candidates = [];

    for (const packId of packIds) {
      const index = await this.getIndex(packId);
      if (!index) continue;

      for (const entry of index) {
        if (entry.type !== "treasure" && entry.type !== "loot") continue;
        const price = entry.system?.price?.value ?? entry.system?.price ?? 0;
        if (Number(price) === gpValue) {
          candidates.push({ packId, id: entry._id });
        }
      }
    }

    if (!candidates.length) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return game.packs.get(pick.packId).getDocument(pick.id);
  },

  /**
   * Find items by item level and type, returning up to `limit` random results.
   * Used by the PF2e adapter for budget-based generation.
   *
   * @param {string[]} packIds
   * @param {{ level: number, type?: string, includeUncommon?: boolean, includeRare?: boolean, limit?: number }} opts
   * @returns {Promise<Item[]>}
   */
  async findByLevelAndType(packIds, { level, type, includeUncommon = false, includeRare = false, limit = 1 } = {}) {
    const candidates = [];

    for (const packId of packIds) {
      const index = await this.getIndex(packId);
      if (!index) continue;

      for (const entry of index) {
        if (entry.type === "spell") continue;
        if (type && entry.type !== type) continue;
        if (entry.system?.level?.value !== level) continue;

        const rarity = (entry.system?.rarity ?? "common").toLowerCase();
        if (rarity === "unique") continue;
        if (rarity === "rare" && !includeRare) continue;
        if (rarity === "uncommon" && !includeUncommon) continue;

        candidates.push({ packId, id: entry._id });
      }
    }

    // Shuffle and take `limit` items
    const shuffled = candidates.sort(() => Math.random() - 0.5).slice(0, limit);
    const docs = await Promise.all(
      shuffled.map(({ packId, id }) => game.packs.get(packId).getDocument(id))
    );
    return docs.filter(Boolean);
  },

  /**
   * General-purpose item search across multiple packs.
   * All filters are optional; omitting one means "any".
   *
   * @param {string[]} packIds
   * @param {{
   *   types?:        string[],   item types to include (OR match)
   *   rarities?:     string[],   normalized rarity strings to include (OR match)
   *   limit?:        number,     max items to return (default 1)
   *   excludeNames?: Set<string> names to skip (de-dupe across calls)
   * }} opts
   * @returns {Promise<Item[]>}
   */
  async findItems(packIds, { types = null, rarities = null, limit = 1, excludeNames = null } = {}) {
    const rarityNorms = rarities?.map((r) => r.toLowerCase().replace(/\s+/g, ""));
    const excluded    = excludeNames instanceof Set ? excludeNames : new Set(excludeNames ?? []);

    // Use the pre-built pool if ready; otherwise build it on demand.
    const pool = this.getPool(packIds) ?? await this.buildPool(packIds);

    let candidates = pool;
    if (excluded.size)       candidates = candidates.filter((e) => !excluded.has(e.name));
    if (types?.length)       candidates = candidates.filter((e) => types.includes(e.type));
    if (rarityNorms?.length) candidates = candidates.filter((e) => rarityNorms.includes(e.rarity));

    if (!candidates.length) return [];
    const picks = candidates.sort(() => Math.random() - 0.5).slice(0, limit);
    const docs  = await Promise.all(picks.map(({ packId, id }) => game.packs.get(packId).getDocument(id)));
    return docs.filter(Boolean);
  },

  /**
   * Find items by rarity string across multiple packs.
   * Used for resolving magic items from DMG-style rarity buckets when a
   * specific name is not available in any loaded compendium.
   *
   * @param {string}   rarity   e.g. "uncommon", "rare", "veryRare", "legendary"
   * @param {string[]} packIds
   * @param {string}   [type]   Optional item type filter
   * @returns {Promise<Item|null>}
   */
  async findRandomByRarity(rarity, packIds, type) {
    const rarityNorm = rarity.toLowerCase().replace(/\s+/g, "");
    const candidates = [];

    for (const packId of packIds) {
      const index = await this.getIndex(packId);
      if (!index) continue;

      for (const entry of index) {
        if (entry.type === "spell") continue;
        if (type && entry.type !== type) continue;
        const entryRarity = (entry.system?.rarity ?? "").toLowerCase().replace(/\s+/g, "");
        if (entryRarity === rarityNorm) candidates.push({ packId, id: entry._id });
      }
    }

    if (!candidates.length) return null;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return game.packs.get(pick.packId).getDocument(pick.id);
  },
};
