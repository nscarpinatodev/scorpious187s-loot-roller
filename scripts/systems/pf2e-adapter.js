/**
 * Pathfinder 2e Loot System Adapter
 *
 * Uses the Party Treasure by Level table (CRB/GM Core) for budget-based
 * loot generation. Items are drawn from the pf2e.equipment-srd compendium
 * filtered by item level and rarity.
 *
 * PF2e-specific field paths (different from dnd5e):
 *   rarity:         system.traits.rarity  ("common"|"uncommon"|"rare"|"unique")
 *   item level:     system.level.value    (nested object, not a bare integer)
 *   identification: system.identification.status  ("identified"|"unidentified")
 *   unidentified name: system.identification.unidentified.name
 *   consumable subtype: system.consumableType.value ("scroll"|"potion"|"elixir"|…)
 */

import { LootRoller } from "../api.js";

const MODULE_ID = "loot-roller";

// ── Item type sets ─────────────────────────────────────────────────────────────
const PF2E_LOOT_TYPES  = new Set(["weapon", "armor", "shield", "equipment", "consumable", "treasure"]);
const PERMANENT_TYPES  = ["weapon", "armor", "shield", "equipment"];
const CONSUMABLE_TYPES = ["consumable"];

// ── PF2e-specific index / pool cache ──────────────────────────────────────────
// CompendiumHelper's buildPool reads system.rarity (dnd5e path), which doesn't
// exist in PF2e.  We maintain a separate cache that reads the correct fields.

const _pf2eIndexCache = new Map(); // packId → Collection
const _pf2ePoolCache  = new Map(); // sorted-packIds key → array

/**
 * Fetch (and cache) a PF2e-correct index for one pack.
 * Requests the fields PF2e actually uses; handles both nested-object and
 * flat-dot-key index formats (which vary across Foundry versions).
 */
async function _getPf2eIndex(packId) {
  if (_pf2eIndexCache.has(packId)) return _pf2eIndexCache.get(packId);
  const pack = game.packs.get(packId);
  if (!pack) return null;
  const index = await pack.getIndex({
    fields: [
      "name", "type", "img",
      "system.level",
      "system.traits.rarity",
      "system.consumableType",
      "system.price",
    ],
  }).catch((err) => {
    console.warn(`LootRoller | PF2e getIndex failed for "${packId}":`, err);
    return null;
  });
  if (index) _pf2eIndexCache.set(packId, index);
  return index;
}

/**
 * Build (and cache) a flat array of loot-eligible PF2e items from multiple packs.
 * Each entry carries the correctly extracted rarity, item level, and consumable type.
 */
async function _buildPf2ePool(packIds) {
  const key = [...packIds].sort().join(",");
  if (_pf2ePoolCache.has(key)) return _pf2ePoolCache.get(key);

  const pool = [];
  for (const packId of packIds) {
    const index = await _getPf2eIndex(packId);
    if (!index) continue;
    for (const entry of index) {
      if (!PF2E_LOOT_TYPES.has(entry.type)) continue;

      // Rarity — PF2e: system.traits.rarity; fall back through dnd5e path too
      const rarityRaw =
        entry.system?.traits?.rarity ??
        entry["system.traits.rarity"] ??
        entry.system?.rarity ??
        "common";
      const rarity = String(rarityRaw).toLowerCase();

      // Level — PF2e: system.level.value (nested); handle plain-number fallback
      const levelObj = entry.system?.level ?? entry["system.level"];
      const level    = levelObj?.value ?? (typeof levelObj === "number" ? levelObj : 0);

      // Consumable subtype — PF2e: system.consumableType.value
      const ctObj         = entry.system?.consumableType ?? entry["system.consumableType"];
      const consumableType = (ctObj?.value ?? "").toLowerCase();

      pool.push({ packId, id: entry._id, name: entry.name, type: entry.type, rarity, level, consumableType, img: entry.img });
    }
  }

  _pf2ePoolCache.set(key, pool);
  console.log(`LootRoller | PF2e pool ready: ${pool.length} items across ${packIds.length} pack(s)`);
  return pool;
}

/** Clear all PF2e-specific caches (call when compendium selection changes). */
function _clearPf2eCache() {
  _pf2eIndexCache.clear();
  _pf2ePoolCache.clear();
}

/**
 * Filter the pool by item type category, level tolerance, and rarity flags.
 * @param {object[]} pool
 * @param {{ allowedTypes: string[], targetLevel: number, tolerance: number, includeUncommon: boolean, includeRare: boolean }} opts
 */
function _filterPool(pool, { allowedTypes, targetLevel, tolerance, includeUncommon, includeRare }) {
  return pool.filter((e) => {
    if (!allowedTypes.includes(e.type))             return false;
    if (Math.abs(e.level - targetLevel) > tolerance) return false;
    if (e.rarity === "unique")                       return false;
    if (e.rarity === "rare"     && !includeRare)     return false;
    if (e.rarity === "uncommon" && !includeUncommon) return false;
    return true;
  });
}

/**
 * Return a generic display label for a PF2e mystified item based on its type.
 * Used as system.identification.unidentified.name so PF2e hides the real name.
 */
function _pf2eUnidentifiedLabel(data) {
  const consumableType = data.system?.consumableType?.value ?? "";
  switch (data.type) {
    case "weapon":     return "Unidentified Weapon";
    case "armor":      return "Unidentified Armor";
    case "shield":     return "Unidentified Shield";
    case "consumable":
      if (consumableType === "scroll") return "Unidentified Scroll";
      if (consumableType === "potion") return "Unidentified Potion";
      if (consumableType === "wand")   return "Unidentified Wand";
      if (consumableType === "elixir") return "Unidentified Elixir";
      return "Unidentified Consumable";
    default:
      return "Unidentified Item";
  }
}

// ── Party Treasure by Level (4-player base, GM Core) ──────────────────────────
const TREASURE_BY_LEVEL = {
  1:  { total: 175,    permanent: [[2,2],[2,1]],       consumables: [[2,2],[2,1],[3,1]],        currency: 40,    perPC: 10 },
  2:  { total: 300,    permanent: [[2,3],[2,2]],       consumables: [[2,3],[2,2],[2,1]],        currency: 70,    perPC: 18 },
  3:  { total: 500,    permanent: [[2,4],[2,3]],       consumables: [[2,4],[2,3],[2,2]],        currency: 120,   perPC: 30 },
  4:  { total: 850,    permanent: [[2,5],[2,4]],       consumables: [[2,5],[2,4],[2,3]],        currency: 200,   perPC: 50 },
  5:  { total: 1350,   permanent: [[2,6],[2,5]],       consumables: [[2,6],[2,5],[2,4]],        currency: 320,   perPC: 80 },
  6:  { total: 2000,   permanent: [[2,7],[2,6]],       consumables: [[2,7],[2,6],[2,5]],        currency: 500,   perPC: 125 },
  7:  { total: 2900,   permanent: [[2,8],[2,7]],       consumables: [[2,8],[2,7],[2,6]],        currency: 720,   perPC: 180 },
  8:  { total: 4000,   permanent: [[2,9],[2,8]],       consumables: [[2,9],[2,8],[2,7]],        currency: 1000,  perPC: 250 },
  9:  { total: 5700,   permanent: [[2,10],[2,9]],      consumables: [[2,10],[2,9],[2,8]],       currency: 1400,  perPC: 350 },
  10: { total: 8000,   permanent: [[2,11],[2,10]],     consumables: [[2,11],[2,10],[2,9]],      currency: 2000,  perPC: 500 },
  11: { total: 11500,  permanent: [[2,12],[2,11]],     consumables: [[2,12],[2,11],[2,10]],     currency: 2800,  perPC: 700 },
  12: { total: 16500,  permanent: [[2,13],[2,12]],     consumables: [[2,13],[2,12],[2,11]],     currency: 4000,  perPC: 1000 },
  13: { total: 23000,  permanent: [[2,14],[2,13]],     consumables: [[2,14],[2,13],[2,12]],     currency: 5600,  perPC: 1400 },
  14: { total: 33000,  permanent: [[2,15],[2,14]],     consumables: [[2,15],[2,14],[2,13]],     currency: 8000,  perPC: 2000 },
  15: { total: 46000,  permanent: [[2,16],[2,15]],     consumables: [[2,16],[2,15],[2,14]],     currency: 11200, perPC: 2800 },
  16: { total: 67000,  permanent: [[2,17],[2,16]],     consumables: [[2,17],[2,16],[2,15]],     currency: 16000, perPC: 4000 },
  17: { total: 95000,  permanent: [[2,18],[2,17]],     consumables: [[2,18],[2,17],[2,16]],     currency: 24000, perPC: 6000 },
  18: { total: 135000, permanent: [[2,19],[2,18]],     consumables: [[2,19],[2,18],[2,17]],     currency: 32000, perPC: 8000 },
  19: { total: 200000, permanent: [[2,20],[2,19]],     consumables: [[2,20],[2,19],[2,18]],     currency: 48000, perPC: 12000 },
  20: { total: 490000, permanent: [[4,20]],            consumables: [[4,20],[2,19]],            currency: 140000,perPC: 35000 },
};

const PACK_IDS = ["pf2e.equipment-srd", "pf2e.equipment"];

// ── Adapter ───────────────────────────────────────────────────────────────────

export class PF2eAdapter {
  static systemId   = "pf2e";
  static systemName = "Pathfinder 2nd Edition";

  static getGeneratorFields() {
    return [
      {
        name: "partyLevel",
        label: "LOOTROLLER.pf2e.field.partyLevel",
        type: "number",
        default: 1,
        min: 1,
        max: 20,
      },
      {
        name: "partySize",
        label: "LOOTROLLER.pf2e.field.partySize",
        type: "number",
        default: 4,
        min: 1,
        max: 8,
        hint: "LOOTROLLER.pf2e.field.partySizeHint",
      },
      {
        name: "lootScope",
        label: "LOOTROLLER.pf2e.field.lootScope",
        type: "select",
        options: [
          { value: "full",      label: "LOOTROLLER.pf2e.lootScope.full" },
          { value: "encounter", label: "LOOTROLLER.pf2e.lootScope.encounter" },
          { value: "custom",    label: "LOOTROLLER.pf2e.lootScope.custom" },
        ],
        default: "full",
      },
      {
        name: "customBudget",
        label: "LOOTROLLER.pf2e.field.customBudget",
        type: "number",
        default: 0,
        hint: "LOOTROLLER.pf2e.field.customBudgetHint",
        showWhen: { field: "lootScope", value: "custom" },
      },
      {
        name: "includeUncommon",
        label: "LOOTROLLER.pf2e.field.includeUncommon",
        type: "checkbox",
        default: true,
      },
      {
        name: "includeRare",
        label: "LOOTROLLER.pf2e.field.includeRare",
        type: "checkbox",
        default: false,
      },
    ];
  }

  static async generateLoot(params) {
    const partyLevel      = Math.min(20, Math.max(1, parseInt(params.partyLevel) || 1));
    const partySize       = Math.max(1, parseInt(params.partySize) || 4);
    const includeUncommon = !!params.includeUncommon;
    const includeRare     = !!params.includeRare;

    const row = TREASURE_BY_LEVEL[partyLevel];
    if (!row) return { coins: {}, items: [] };

    const sizeAdjust = (partySize - 4) * row.perPC;

    let budgetGP;
    if (params.lootScope === "custom") {
      budgetGP = Math.max(0, parseInt(params.customBudget) || 0);
    } else if (params.lootScope === "encounter") {
      budgetGP = Math.round((row.total + sizeAdjust) / 10);
    } else {
      budgetGP = row.total + sizeAdjust;
    }

    const itemRefs = [];

    for (const [count, level] of (row.permanent ?? [])) {
      for (let i = 0; i < count; i++) {
        itemRefs.push({ name: null, type: null, rarity: "common", level, _pf2eType: "permanent", includeUncommon, includeRare });
      }
    }

    for (const [count, level] of (row.consumables ?? [])) {
      for (let i = 0; i < count; i++) {
        itemRefs.push({ name: null, type: "consumable", rarity: "common", level, _pf2eType: "consumable", includeUncommon, includeRare });
      }
    }

    const currencyGP = Math.min(budgetGP, row.currency + Math.max(0, sizeAdjust));
    const coins = { gp: Math.floor(currencyGP), sp: 0, cp: 0 };

    return { coins, items: itemRefs };
  }

  static async resolveItems(itemRefs) {
    const resolved = [];
    const packs    = PF2eAdapter.getActivePacks();
    const pool     = await _buildPf2ePool(packs);

    let includeUncommon = false;
    let includeRare     = false;
    try { includeUncommon = game.settings.get(MODULE_ID, "pf2e.includeUncommon"); } catch {}
    try { includeRare     = game.settings.get(MODULE_ID, "pf2e.includeRare");     } catch {}

    for (const ref of itemRefs) {
      const isPermanent  = ref._pf2eType === "permanent";
      const targetLevel  = ref.level ?? 1;
      const allowedTypes = isPermanent ? PERMANENT_TYPES : CONSUMABLE_TYPES;

      // Merge per-ref overrides with global settings
      const wantUncommon = ref.includeUncommon ?? includeUncommon;
      const wantRare     = ref.includeRare     ?? includeRare;

      // Try ±1 level first, then widen to ±2 if nothing found
      let candidates = _filterPool(pool, { allowedTypes, targetLevel, tolerance: 1, includeUncommon: wantUncommon, includeRare: wantRare });
      if (!candidates.length) {
        candidates = _filterPool(pool, { allowedTypes, targetLevel, tolerance: 2, includeUncommon: true, includeRare: wantRare });
      }

      if (!candidates.length) {
        resolved.push({
          name:  `${isPermanent ? "Item" : "Consumable"} (Level ${targetLevel})`,
          type:  isPermanent ? "equipment" : "consumable",
          level: targetLevel,
          stub:  true,
        });
        continue;
      }

      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      const doc  = await game.packs.get(pick.packId)?.getDocument(pick.id).catch(() => null);

      if (doc) {
        // Rare and unique items arrive mystified
        if (pick.rarity === "rare" || pick.rarity === "unique") {
          const data = doc.toObject();
          data._sourceUuid = doc.uuid;
          PF2eAdapter.applyMystification(data);
          resolved.push(data);
        } else {
          resolved.push(doc);
        }
      } else {
        resolved.push({
          name:  `${isPermanent ? "Item" : "Consumable"} (Level ${targetLevel})`,
          type:  pick.type,
          level: targetLevel,
          stub:  true,
        });
      }
    }

    return resolved;
  }

  static getCompendiumPacks() {
    return PACK_IDS;
  }

  static getSettings() {
    return [
      {
        key: "pf2e.includeUncommon",
        name: "LOOTROLLER.settings.pf2e.includeUncommon.name",
        hint: "LOOTROLLER.settings.pf2e.includeUncommon.hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
      },
      {
        key: "pf2e.includeRare",
        name: "LOOTROLLER.settings.pf2e.includeRare.name",
        hint: "LOOTROLLER.settings.pf2e.includeRare.hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: false,
      },
    ];
  }

  static getItemTypes() {
    return [
      { value: "weapon",     label: "LOOTROLLER.itemType.weapon" },
      { value: "armor",      label: "LOOTROLLER.itemType.armor" },
      { value: "shield",     label: "LOOTROLLER.itemType.shield" },
      { value: "equipment",  label: "LOOTROLLER.itemType.equipment" },
      { value: "consumable", label: "LOOTROLLER.itemType.consumable" },
      { value: "treasure",   label: "LOOTROLLER.itemType.treasure" },
    ];
  }

  static getRarities() {
    return [
      { value: "common",   label: "LOOTROLLER.rarity.common" },
      { value: "uncommon", label: "LOOTROLLER.rarity.uncommon" },
      { value: "rare",     label: "LOOTROLLER.rarity.rare" },
      { value: "unique",   label: "LOOTROLLER.rarity.unique" },
    ];
  }

  /** Return the pack IDs to search, respecting the user's compendium selection. */
  static getActivePacks() {
    try {
      const setting = game.settings.get("loot-roller", "compendiumPacks");
      if (setting && Object.keys(setting).length) {
        const enabled = Object.entries(setting)
          .filter(([, on]) => on)
          .map(([id]) => id)
          .filter((id) => game.packs.has(id));
        if (enabled.length) return enabled;
      }
    } catch {}
    return PACK_IDS.filter((id) => game.packs.has(id));
  }

  /** Pre-warm the PF2e pool (clears old cache first). */
  static async warmPool() {
    _clearPf2eCache();
    return _buildPf2ePool(PF2eAdapter.getActivePacks());
  }

  /**
   * Describe the level-based filter this system uses in place of rarity.
   * Returning a non-null value causes the quest/shop generators to show a
   * party-level input instead of rarity buttons.
   *
   * mode "partyLevel": a single party-level number (1–20); the adapter converts
   * it to an appropriate item-level window internally.
   *
   * @returns {{ mode: "partyLevel", min: number, max: number, default: number }}
   */
  static getItemLevelRange() {
    return { mode: "partyLevel", min: 1, max: 20, default: 5 };
  }

  /**
   * Convert a party level to the item-level window used for compendium search.
   * Mirrors the spread in TREASURE_BY_LEVEL: items are at partyLevel–1 through
   * partyLevel+2, clamped to [1, 25].
   *
   * @param {number} partyLevel
   * @returns {[number, number]}
   */
  static partyLevelToItemRange(partyLevel) {
    return [Math.max(1, partyLevel - 1), Math.min(25, partyLevel + 2)];
  }

  /**
   * Find compendium items matching the given filters.
   * Uses the PF2e-specific pool so rarity is read from system.traits.rarity.
   *
   * @param {{
   *   rarities?:     string[],
   *   types?:        string[],
   *   limit?:        number,
   *   excludeNames?: Set<string>,
   *   partyLevel?:   number      PF2e: converted to item-level window, replaces rarities
   * }} params
   */
  static async findItems({ rarities, types, limit = 1, excludeNames, partyLevel } = {}) {
    const packs = PF2eAdapter.getActivePacks();
    const pool  = await _buildPf2ePool(packs);

    const rarityNorms = rarities?.map((r) => r.toLowerCase().replace(/\s+/g, ""));
    const excluded    = excludeNames instanceof Set ? excludeNames : new Set(excludeNames ?? []);

    let candidates = pool;
    if (excluded.size) candidates = candidates.filter((e) => !excluded.has(e.name));
    if (types?.length) candidates = candidates.filter((e) => types.includes(e.type));

    if (partyLevel !== undefined) {
      const [minL, maxL] = PF2eAdapter.partyLevelToItemRange(partyLevel);
      candidates = candidates.filter((e) => e.level >= minL && e.level <= maxL);
    } else if (rarityNorms?.length) {
      candidates = candidates.filter((e) => rarityNorms.includes(e.rarity));
    }

    if (!candidates.length) return [];
    const picks = candidates.sort(() => Math.random() - 0.5).slice(0, limit);
    const docs  = await Promise.all(picks.map(({ packId, id }) => game.packs.get(packId).getDocument(id)));
    return docs.filter(Boolean);
  }

  /** Clear the PF2e pool cache — called by CompendiumSettingsApp when packs change. */
  static clearPool() {
    _clearPf2eCache();
  }

  // ── Identification helpers (PF2e uses system.identification.status) ──────────

  /**
   * Apply mystification to a plain item data object.
   * Sets system.identification.status = "unidentified" and fills in a generic
   * unidentified name so PF2e hides the real item name from players.
   *
   * @param {object} data  Plain item data object (from toObject() or plain JS).
   */
  static applyMystification(data) {
    if (!data.system?.identification) return;
    data.system.identification.status = "unidentified";
    data.system.identification.unidentified ??= {};
    if (!data.system.identification.unidentified.name) {
      data.system.identification.unidentified.name = _pf2eUnidentifiedLabel(data);
    }
  }

  /**
   * Remove mystification from a plain item data object.
   */
  static clearMystification(data) {
    if (!data.system?.identification) return;
    data.system.identification.status = "identified";
  }

  /**
   * Return true if the item data is in an unidentified state.
   * @param {object} data
   */
  static isMystified(data) {
    return data.system?.identification?.status === "unidentified";
  }

  /**
   * Read the display name for an item, respecting PF2e identification.
   * @param {object} item
   */
  static getDisplayName(item) {
    if (item.system?.identification?.status === "unidentified") {
      return item.system.identification.unidentified?.name
        || game.i18n.localize("LOOTROLLER.lottery.unidentifiedItem");
    }
    return item.name;
  }

  /**
   * Read the display description for an item, respecting PF2e identification.
   * @param {object} item
   */
  static getDisplayDescription(item) {
    if (item.system?.identification?.status === "unidentified") {
      return item.system.identification.unidentified?.description ?? "";
    }
    return item.system?.description?.value ?? "";
  }
}

Hooks.once("init", () => {
  if (game.system.id === "pf2e") {
    LootRoller.registerSystem(PF2eAdapter);
  }
});
