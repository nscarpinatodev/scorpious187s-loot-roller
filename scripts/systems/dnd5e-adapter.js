/**
 * D&D 5e Loot System Adapter
 *
 * Supports dnd5e system versions 5.2.x (Foundry v13) and 5.3.x (Foundry v14).
 * Items are drawn entirely from the GM's selected compendiums; no edition
 * lookup tables are used.
 */

import { LootRoller } from "../api.js";
import { CompendiumHelper } from "../compendium-helper.js";

const MODULE_ID = "loot-roller";

/** True when running dnd5e 5.3.x or later. */
const IS_DND5E_53 = () => foundry.utils.isNewerVersion(game.system.version, "5.2.99");

/** Parse a dice formula string like "3d6", "4d6*100", "1d4-1" into a numeric result. */
function _rollFormula(formula) {
  const match = formula.match(/^(\d+)d(\d+)(?:\*(\d+)|([+-]\d+))?$/i);
  if (!match) {
    const fixed = parseInt(formula, 10);
    return isNaN(fixed) ? 0 : fixed;
  }
  const [, n, x, multiplier, modifier] = match;
  let total = 0;
  for (let i = 0; i < Number(n); i++) total += Math.floor(Math.random() * Number(x)) + 1;
  if (multiplier) total *= Number(multiplier);
  if (modifier) total += Number(modifier);
  return Math.max(0, total);
}

/** Return a random integer between min and max inclusive. */
function _randInt(min, max) {
  if (max <= min) return min;
  return min + Math.floor(Math.random() * (max - min + 1));
}

// ── Hoard configuration ───────────────────────────────────────────────────────

/**
 * Coin formulas for individual (per-creature) and hoard rolls, keyed by CR bracket.
 * Values are dice formula strings parsed by _rollFormula.
 */
const INDIVIDUAL_COINS = {
  cr0_4:    { cp: "2d6*10",   sp: "1d4*10"  },
  cr5_10:   { sp: "2d6*10",   gp: "2d6*10"  },
  cr11_16:  { gp: "2d6*100",  pp: "1d4*10"  },
  cr17plus: { gp: "2d6*1000", pp: "1d4*100" },
};

const HOARD_COINS = {
  cr0_4:    { cp: "2d6*100",  sp: "1d6*100",  gp: "2d6*10"   },
  cr5_10:   { gp: "2d6*100",  pp: "1d4*100"                   },
  cr11_16:  { gp: "2d6*1000", pp: "2d4*100"                   },
  cr17plus: { gp: "2d6*10000",pp: "1d4*1000"                  },
};

/**
 * Hoard item configuration per CR bracket.
 *   magic: { rarity: [min, max] } — random compendium items per rarity
 *   gems:  { count: [min, max], tiers: [gpValues] } — DMG gem table entries
 *   art:   { count: [min, max], tiers: [gpValues] } — DMG art object table entries
 */
const HOARD_ITEMS = {
  cr0_4: {
    magic: { common: [2, 6],  uncommon: [0, 3],  rare: [0, 0], veryRare: [0, 0], legendary: [0, 0] },
    gems:  { count: [1, 4],   tiers: [10, 50]    },
    art:   { count: [0, 3],   tiers: [25]         },
  },
  cr5_10: {
    magic: { common: [1, 4],  uncommon: [2, 6],  rare: [0, 2], veryRare: [0, 0], legendary: [0, 0] },
    gems:  { count: [2, 6],   tiers: [50, 100]   },
    art:   { count: [1, 4],   tiers: [25, 250]   },
  },
  cr11_16: {
    magic: { common: [0, 3],  uncommon: [2, 5],  rare: [1, 4], veryRare: [0, 2], legendary: [0, 0] },
    gems:  { count: [2, 6],   tiers: [100, 500]  },
    art:   { count: [1, 4],   tiers: [250, 750]  },
  },
  cr17plus: {
    magic: { common: [0, 2],  uncommon: [1, 4],  rare: [2, 5], veryRare: [1, 3], legendary: [0, 2] },
    gems:  { count: [3, 8],   tiers: [500, 1000, 5000]  },
    art:   { count: [2, 6],   tiers: [750, 2500, 7500]  },
  },
};

// ── Gem and art object tables (2014 DMG) ──────────────────────────────────────

/** DMG gem tables keyed by GP value. Each entry: { name, description }. */
const GEM_TABLES = {
  10: [
    { name: "Azurite",           description: "Opaque mottled deep blue" },
    { name: "Banded Agate",      description: "Translucent striped brown, blue, white, or red" },
    { name: "Blue Quartz",       description: "Transparent pale blue" },
    { name: "Eye Agate",         description: "Translucent circles of gray, white, brown, blue, or green" },
    { name: "Hematite",          description: "Opaque gray-black" },
    { name: "Lapis Lazuli",      description: "Opaque light and dark blue with yellow flecks" },
    { name: "Malachite",         description: "Opaque striated light and dark green" },
    { name: "Moss Agate",        description: "Translucent pink with mossy gray or green markings" },
    { name: "Obsidian",          description: "Opaque black" },
    { name: "Rhodonite",         description: "Opaque light pink" },
    { name: "Tiger Eye",         description: "Translucent brown with golden center" },
    { name: "Turquoise",         description: "Opaque light blue-green" },
  ],
  50: [
    { name: "Bloodstone",        description: "Opaque dark gray with red flecks" },
    { name: "Carnelian",         description: "Opaque orange to red-brown" },
    { name: "Chalcedony",        description: "Opaque white" },
    { name: "Chrysoprase",       description: "Translucent green" },
    { name: "Citrine",           description: "Transparent pale yellow-brown" },
    { name: "Jasper",            description: "Opaque blue, black, or brown" },
    { name: "Moonstone",         description: "Translucent white with pale blue glow" },
    { name: "Onyx",              description: "Opaque bands of black and white, or pure black or white" },
    { name: "Quartz",            description: "Transparent white, smoky gray, or yellow" },
    { name: "Sardonyx",          description: "Opaque bands of red and white" },
    { name: "Star Rose Quartz",  description: "Translucent rosy stone with white star-shaped center" },
    { name: "Zircon",            description: "Transparent pale blue-green" },
  ],
  100: [
    { name: "Amber",             description: "Transparent watery gold to rich gold" },
    { name: "Amethyst",          description: "Transparent deep purple" },
    { name: "Chrysoberyl",       description: "Transparent yellow-green to pale green" },
    { name: "Coral",             description: "Opaque crimson" },
    { name: "Garnet",            description: "Transparent red, brown-green, or violet" },
    { name: "Jade",              description: "Translucent white, light green, or dark green" },
    { name: "Jet",               description: "Opaque deep black" },
    { name: "Pearl",             description: "Opaque lustrous white, yellow, or pink" },
    { name: "Spinel",            description: "Transparent red, red-brown, or deep green" },
    { name: "Tourmaline",        description: "Transparent pale green, blue, brown, or red" },
  ],
  500: [
    { name: "Alexandrite",       description: "Transparent dark green" },
    { name: "Aquamarine",        description: "Transparent pale blue-green" },
    { name: "Black Pearl",       description: "Opaque pure black" },
    { name: "Blue Spinel",       description: "Transparent deep blue" },
    { name: "Peridot",           description: "Transparent rich olive green" },
    { name: "Topaz",             description: "Transparent golden yellow" },
  ],
  1000: [
    { name: "Black Opal",        description: "Translucent dark green with black mottling and golden flecks" },
    { name: "Blue Sapphire",     description: "Transparent blue-white to medium blue" },
    { name: "Emerald",           description: "Transparent deep bright green" },
    { name: "Fire Opal",         description: "Translucent fiery red" },
    { name: "Opal",              description: "Translucent pale blue with green and golden mottling" },
    { name: "Star Ruby",         description: "Translucent ruby with white star-shaped center" },
    { name: "Star Sapphire",     description: "Translucent blue sapphire with white star-shaped center" },
    { name: "Yellow Sapphire",   description: "Transparent fiery yellow or yellow-green" },
  ],
  5000: [
    { name: "Black Sapphire",    description: "Translucent lustrous black with glowing highlights" },
    { name: "Diamond",           description: "Transparent blue-white, canary, pink, brown, or blue" },
    { name: "Jacinth",           description: "Transparent fiery orange" },
    { name: "Ruby",              description: "Transparent clear red to deep crimson" },
  ],
};

/** DMG art object tables keyed by GP value. Each entry: { name }. */
const ART_TABLES = {
  25: [
    { name: "Silver Ewer" },
    { name: "Carved Bone Statuette" },
    { name: "Small Gold Bracelet" },
    { name: "Cloth-of-Gold Vestments" },
    { name: "Black Velvet Mask Stitched with Silver Thread" },
    { name: "Copper Chalice with Silver Filigree" },
    { name: "Pair of Engraved Bone Dice" },
    { name: "Small Mirror in a Painted Wooden Frame" },
    { name: "Embroidered Silk Handkerchief" },
    { name: "Gold Locket with a Painted Portrait Inside" },
  ],
  250: [
    { name: "Gold Ring Set with Bloodstones" },
    { name: "Carved Ivory Statuette" },
    { name: "Large Gold Bracelet" },
    { name: "Silver Necklace with a Gemstone Pendant" },
    { name: "Bronze Crown" },
    { name: "Silk Robe with Gold Embroidery" },
    { name: "Large Well-Made Tapestry" },
    { name: "Brass Mug with Jade Inlay" },
    { name: "Box of Turquoise Animal Figurines" },
    { name: "Gold Bird Cage with Electrum Filigree" },
  ],
  750: [
    { name: "Silver Chalice Set with Moonstones" },
    { name: "Silver-Plated Longsword with Jet Set in the Hilt" },
    { name: "Carved Harp of Exotic Wood with Ivory Inlay and Zircon Gems" },
    { name: "Small Gold Idol" },
    { name: "Gold Dragon Comb Set with Red Garnets as Eyes" },
    { name: "Bottle Stopper Cork Embossed with Gold Leaf and Set with Amethysts" },
    { name: "Ceremonial Electrum Dagger with a Black Pearl in the Pommel" },
    { name: "Silver and Gold Brooch" },
    { name: "Obsidian Statuette with Gold Fittings and Inlay" },
    { name: "Painted Gold War Mask" },
  ],
  2500: [
    { name: "Fine Gold Chain Set with a Fire Opal" },
    { name: "Old Masterwork Painting" },
    { name: "Embroidered Silk and Velvet Mantle Set with Moonstones" },
    { name: "Platinum Bracelet Set with a Sapphire" },
    { name: "Embroidered Glove Set with Jewel Chips" },
    { name: "Jeweled Anklet" },
    { name: "Gold Music Box" },
    { name: "Gold Circlet Set with Four Aquamarines" },
    { name: "Eye Patch with a Mock Eye of Blue Sapphire and Moonstone" },
    { name: "Necklace String of Small Pink Pearls" },
  ],
  7500: [
    { name: "Jeweled Gold Crown" },
    { name: "Jeweled Platinum Ring" },
    { name: "Small Gold Statuette Set with Rubies" },
    { name: "Gold Cup Set with Emeralds" },
    { name: "Gold Jewelry Box with Platinum Filigree" },
    { name: "Painted Gold Child's Sarcophagus" },
    { name: "Jade Game Board with Solid Gold Playing Pieces" },
    { name: "Bejeweled Ivory Drinking Horn with Gold Filigree" },
  ],
};

/**
 * Build a dnd5e loot item data object from treasure table data.
 * Uses the structure from the system's loot item type.
 */
function _createTreasureItemData(name, description, gpValue) {
  return {
    name,
    type:   "loot",
    img:    "systems/dnd5e/icons/svg/items/loot.svg",
    system: {
      description: {
        value: description ? `<p>${description}</p>` : "",
        chat:  "",
      },
      quantity:    1,
      weight:      { value: 0, units: "lb" },
      price:       { value: gpValue, denomination: "gp" },
      rarity:      "",
      identified:  true,
      unidentified: { description: "" },
      properties:  [],
      type:        { value: "", subtype: "" },
    },
    effects: [],
    flags:   {},
  };
}

// ── Spell scroll configuration ───────────────────────────────────────────────

/**
 * DMG / XGtE market values for spell scrolls, indexed by spell level (0 = cantrip).
 * Rarity follows the 2014 DMG table; pricing from Xanathar's Guide p.133.
 */
const SCROLL_LEVEL_DATA = [
  { rarity: "common",    gp: 25 },     // cantrip
  { rarity: "common",    gp: 75 },     // 1st
  { rarity: "uncommon",  gp: 150 },    // 2nd
  { rarity: "uncommon",  gp: 300 },    // 3rd
  { rarity: "rare",      gp: 500 },    // 4th
  { rarity: "rare",      gp: 1000 },   // 5th
  { rarity: "veryRare",  gp: 2000 },   // 6th
  { rarity: "veryRare",  gp: 3500 },   // 7th
  { rarity: "veryRare",  gp: 6000 },   // 8th
  { rarity: "legendary", gp: 10000 },  // 9th
];

/** Maps normalized rarity string → eligible spell levels for Quest Generator rolling. */
const SCROLL_RARITY_LEVELS = {
  common:    [0, 1],
  uncommon:  [2, 3],
  rare:      [4, 5],
  veryrare:  [6, 7, 8],
  legendary: [9],
};

/**
 * Parse a spell scroll item name and return a spell level integer.
 * Handles both 2014 ("Spell Scroll (3rd Level)") and 2024 grouped formats
 * ("Spell Scroll (Cantrip or Level 1)"). Returns null for non-scroll names.
 */
function _parseScrollRef(name) {
  if (!name || !/^Spell Scroll/i.test(name)) return null;
  const m = name.match(/\((.+?)\)/);
  if (!m) return null;
  const inner = m[1].toLowerCase();
  const levels = [];
  if (inner.includes("cantrip")) levels.push(0);
  for (const nm of inner.matchAll(/\b(\d+)(?:st|nd|rd|th)?\b/g)) {
    const lvl = parseInt(nm[1]);
    if (lvl >= 1 && lvl <= 9 && !levels.includes(lvl)) levels.push(lvl);
  }
  if (!levels.length) return null;
  return levels[Math.floor(Math.random() * levels.length)];
}

/**
 * Find a random spell document at the given level (0 = cantrip) from the
 * dnd5e spells compendium.
 *
 * @param {number} level
 * @returns {Promise<Item|null>}
 */
async function _findRandomSpellAtLevel(level) {
  const spellPacks = [
    ...(IS_DND5E_53() ? ["dnd5e.spells24"] : []),
    "dnd5e.spells",
  ].filter((id) => game.packs.has(id));

  for (const packId of spellPacks) {
    const index = await CompendiumHelper.getIndex(packId);
    if (!index) continue;
    const candidates = [...index].filter(
      (e) => e.type === "spell" && (e.system?.level ?? 0) === level
    );
    if (!candidates.length) continue;
    const pick = candidates[Math.floor(Math.random() * candidates.length)];
    return game.packs.get(packId).getDocument(pick._id);
  }
  return null;
}

/**
 * Create a spell scroll plain-data object from a spell document.
 * Calls dnd5e's createScrollFromSpell API and applies DMG/XGtE market pricing.
 * Passes { temporary: true } so the scroll is never persisted to the world.
 *
 * @param {Item} spellDoc
 * @returns {Promise<object|null>}
 */
async function _createScrollFromSpellDoc(spellDoc) {
  const createFn = CONFIG.Item?.documentClass?.createScrollFromSpell;
  if (typeof createFn !== "function") {
    console.warn("LootRoller | dnd5e createScrollFromSpell API not available");
    return null;
  }

  const level = spellDoc.system?.level ?? 0;
  const { rarity, gp } = SCROLL_LEVEL_DATA[Math.min(level, 9)] ?? SCROLL_LEVEL_DATA[1];

  let scrollDoc;
  try {
    scrollDoc = await createFn.call(CONFIG.Item.documentClass, spellDoc, {
      temporary:    true,
      renderSheet:  false,
      dialog:       false,
    });
  } catch (err) {
    console.error("LootRoller | createScrollFromSpell failed:", err);
    return null;
  }
  if (!scrollDoc) return null;

  const data = scrollDoc.toObject?.() ?? { ...scrollDoc };
  delete data._id;

  if (data.system) {
    data.system.price  = { value: gp, denomination: "gp" };
    data.system.rarity = rarity;
  }

  // Guard: if { temporary: true } was ignored and a world item was created, clean it up
  if (scrollDoc.id && game.items?.has(scrollDoc.id)) {
    await scrollDoc.delete().catch(() => {});
  }

  return data;
}

/** Find a random spell at `level` and return scroll item data. */
async function _createScrollAtLevel(level) {
  const spellDoc = await _findRandomSpellAtLevel(level);
  if (!spellDoc) return null;
  return _createScrollFromSpellDoc(spellDoc);
}

/**
 * Find `limit` spell scroll items, mapping the supplied rarities to appropriate
 * spell levels. Respects the excludeNames de-dupe set.
 */
async function _findScrollItems(rarities, limit, excludeNames) {
  const excluded = excludeNames instanceof Set ? excludeNames : new Set(excludeNames ?? []);
  const eligibleLevels = [];
  for (const r of (rarities ?? Object.keys(SCROLL_RARITY_LEVELS))) {
    const key = r.toLowerCase().replace(/\s+/g, "");
    eligibleLevels.push(...(SCROLL_RARITY_LEVELS[key] ?? []));
  }
  if (!eligibleLevels.length) return [];

  const results = [];
  for (let i = 0; i < limit; i++) {
    const level = eligibleLevels[Math.floor(Math.random() * eligibleLevels.length)];
    const data  = await _createScrollAtLevel(level);
    if (data && !excluded.has(data.name)) {
      excluded.add(data.name);
      results.push(data);
    }
  }
  return results;
}

// ── Compendium packs to search ──────────────────────────────────────────────

const PACK_IDS = [
  "dnd5e.items",
  "dnd5e.tradegoods",
  "dnd5e.equipment24",  // 5.3.x
  "dnd5e.magicitems",
  "dnd5e.spells",
];

// ── Adapter ─────────────────────────────────────────────────────────────────

export class DnD5eAdapter {
  static systemId = "dnd5e";
  static systemName = "D&D 5th Edition";

  static getGeneratorFields() {
    return [
      {
        name: "treasureType",
        label: "LOOTROLLER.dnd5e.field.treasureType",
        type: "select",
        options: [
          { value: "individual", label: "LOOTROLLER.dnd5e.treasureType.individual" },
          { value: "hoard",      label: "LOOTROLLER.dnd5e.treasureType.hoard" },
        ],
        default: "hoard",
      },
      {
        name: "bracket",
        label: "LOOTROLLER.dnd5e.field.crRange",
        type: "select",
        options: [
          { value: "cr0_4",    label: game.i18n.localize("LOOTROLLER.dnd5e.cr.0_4") },
          { value: "cr5_10",   label: game.i18n.localize("LOOTROLLER.dnd5e.cr.5_10") },
          { value: "cr11_16",  label: game.i18n.localize("LOOTROLLER.dnd5e.cr.11_16") },
          { value: "cr17plus", label: game.i18n.localize("LOOTROLLER.dnd5e.cr.17plus") },
        ],
        default: "cr0_4",
      },
    ];
  }

  static async generateLoot(params) {
    const { treasureType, bracket } = params;
    const coins = {};
    const itemRefs = [];

    // ── Coins ─────────────────────────────────────────────────────────────────
    const coinTable = treasureType === "individual"
      ? INDIVIDUAL_COINS[bracket]
      : HOARD_COINS[bracket];

    if (!coinTable) {
      ui.notifications.warn(`LootRoller | Unknown bracket: ${bracket}`);
      return { coins: {}, items: [] };
    }

    for (const [denom, formula] of Object.entries(coinTable)) {
      const amount = _rollFormula(formula);
      if (amount > 0) coins[denom] = amount;
    }

    // ── Items (hoard only) ────────────────────────────────────────────────────
    if (treasureType === "hoard") {
      const tier = HOARD_ITEMS[bracket] ?? HOARD_ITEMS.cr0_4;

      // Gems
      const gemCount = _randInt(...tier.gems.count);
      for (let i = 0; i < gemCount; i++) {
        const gpValue = tier.gems.tiers[Math.floor(Math.random() * tier.gems.tiers.length)];
        const pool    = GEM_TABLES[gpValue] ?? [];
        if (!pool.length) continue;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        itemRefs.push({ _gem: true, name: pick.name, description: pick.description, gpValue });
      }

      // Art objects
      const artCount = _randInt(...tier.art.count);
      for (let i = 0; i < artCount; i++) {
        const gpValue = tier.art.tiers[Math.floor(Math.random() * tier.art.tiers.length)];
        const pool    = ART_TABLES[gpValue] ?? [];
        if (!pool.length) continue;
        const pick = pool[Math.floor(Math.random() * pool.length)];
        itemRefs.push({ _art: true, name: pick.name, gpValue });
      }

      // Magic items (from active compendiums by rarity)
      if (game.settings.get(MODULE_ID, "includeMagicItems")) {
        for (const [rarity, [min, max]] of Object.entries(tier.magic)) {
          const count = _randInt(min, max);
          for (let i = 0; i < count; i++) {
            itemRefs.push({ _placeholder: true, rarity });
          }
        }
      }
    }

    return { coins, items: itemRefs };
  }

  static async resolveItems(itemRefs) {
    const resolved    = [];
    const activePacks  = DnD5eAdapter.getActivePacks();
    const usedNames   = new Set();
    const allowDupes  = game.settings.get(MODULE_ID, "allowDuplicateItems");

    for (const ref of itemRefs) {
      // ── Spell scroll: create via dnd5e API by level ───────────────────────────
      if (ref._scrollLevel !== undefined) {
        const data = await _createScrollAtLevel(ref._scrollLevel);
        if (data) { resolved.push(data); continue; }
        // API unavailable — fall through to rarity-based compendium lookup
      }

      // ── Magic item placeholder: pick from active compendiums by rarity ────────
      if (ref._placeholder || ref._scrollLevel !== undefined) {
        const [item] = await CompendiumHelper.findItems(activePacks, {
          rarities:     [ref.rarity],
          limit:        1,
          excludeNames: allowDupes ? null : usedNames,
        });
        if (item) {
          usedNames.add(item.name);
          // Rare and above arrive on actors as unidentified — GM still sees real name in setup
          const MYSTIFY = new Set(["rare", "veryRare", "legendary"]);
          if (MYSTIFY.has(ref.rarity)) {
            const data = item.toObject();
            data.system.identified = false;
            data._sourceUuid = item.uuid;
            resolved.push(data);
          } else {
            resolved.push(item);
          }
        } else {
          resolved.push({
            name:  `Magic Item (${ref.rarity})`,
            img:   "icons/svg/item-bag.svg",
            type:  "loot",
            rarity: ref.rarity,
            stub:  true,
          });
        }
        continue;
      }

      // ── Gem: build a proper loot item with description and price ─────────────
      if (ref._gem) {
        resolved.push(_createTreasureItemData(
          ref.name,
          `<strong>Gemstone.</strong> ${ref.description}. Worth ${ref.gpValue.toLocaleString()} gp.`,
          ref.gpValue,
        ));
        continue;
      }

      // ── Art object: build a proper loot item with price ───────────────────────
      if (ref._art) {
        resolved.push(_createTreasureItemData(
          ref.name,
          `<strong>Art Object.</strong> Worth ${ref.gpValue.toLocaleString()} gp.`,
          ref.gpValue,
        ));
        continue;
      }

      // ── Legacy _treasure ref (backward compat) ────────────────────────────────
      if (ref._treasure) {
        const label = ref.artObject ? `Art Object (${ref.gpValue} gp)` : `Gem (${ref.gpValue} gp)`;
        resolved.push(_createTreasureItemData(
          label,
          `Worth ${ref.gpValue.toLocaleString()} gp.`,
          ref.gpValue,
        ));
        continue;
      }

      // ── Legacy named ref (e.g. from saved lists created before this change) ───
      if (ref.name) {
        const scrollLevel = _parseScrollRef(ref.name);
        if (scrollLevel !== null) {
          const data = await _createScrollAtLevel(scrollLevel);
          if (data) { resolved.push(data); continue; }
        }
        const byName = await CompendiumHelper.findByName(ref.name, activePacks);
        if (byName) { resolved.push(byName); continue; }
        if (ref.rarity) {
          const [fallback] = await CompendiumHelper.findItems(activePacks, {
            rarities:     [ref.rarity],
            limit:        1,
            excludeNames: allowDupes ? null : usedNames,
          });
          if (fallback) { usedNames.add(fallback.name); resolved.push(fallback); continue; }
        }
        resolved.push({
          name:  ref.name,
          img:   "icons/svg/item-bag.svg",
          type:  "loot",
          rarity: ref.rarity ?? "common",
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
        key: "includeMagicItems",
        name: "LOOTROLLER.settings.includeMagicItems.name",
        hint: "LOOTROLLER.settings.includeMagicItems.hint",
        scope: "world",
        config: true,
        type: Boolean,
        default: true,
      },
      {
        key: "allowDuplicateItems",
        name: "LOOTROLLER.settings.allowDuplicateItems.name",
        hint: "LOOTROLLER.settings.allowDuplicateItems.hint",
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
      { value: "equipment",  label: "LOOTROLLER.itemType.equipment" },
      { value: "consumable", label: "LOOTROLLER.itemType.consumable" },
      { value: "loot",       label: "LOOTROLLER.itemType.loot" },
      { value: "tool",       label: "LOOTROLLER.itemType.tool" },
      { value: "scroll",     label: "LOOTROLLER.itemType.scroll" },
    ];
  }

  static getRarities() {
    return [
      { value: "common",    label: "LOOTROLLER.rarity.common" },
      { value: "uncommon",  label: "LOOTROLLER.rarity.uncommon" },
      { value: "rare",      label: "LOOTROLLER.rarity.rare" },
      { value: "veryRare",  label: "LOOTROLLER.rarity.veryRare" },
      { value: "legendary", label: "LOOTROLLER.rarity.legendary" },
    ];
  }

  /** Return the pack IDs to search, respecting the user's compendium selection setting. */
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

  /** Pre-build the item pool so the first roll is instant. */
  static async warmPool() {
    return CompendiumHelper.buildPool(DnD5eAdapter.getActivePacks());
  }

  static async findItems({ rarities, types, limit = 1, excludeNames } = {}) {
    if (types?.includes("scroll")) {
      const nonScrollTypes = types.filter((t) => t !== "scroll");

      // Scroll-only roll
      if (!nonScrollTypes.length) {
        return _findScrollItems(rarities, limit, excludeNames);
      }

      // Mixed types: each slot picks randomly between scroll and a regular type,
      // giving "scroll" equal weight to every other selected type.
      const excluded    = excludeNames instanceof Set ? excludeNames : new Set(excludeNames ?? []);
      const rarityNorms = rarities?.map((r) => r.toLowerCase().replace(/\s+/g, ""));
      const results     = [];

      for (let i = 0; i < limit; i++) {
        if (Math.random() < 1 / types.length) {
          const [scroll] = await _findScrollItems(rarities, 1, excluded);
          if (scroll) { excluded.add(scroll.name); results.push(scroll); continue; }
        }
        const [item] = await CompendiumHelper.findItems(DnD5eAdapter.getActivePacks(), {
          types: nonScrollTypes,
          rarities: rarityNorms,
          limit: 1,
          excludeNames: excluded,
        });
        if (item) { excluded.add(item.name); results.push(item); }
      }
      return results;
    }

    const rarityNorms = rarities?.map((r) => r.toLowerCase().replace(/\s+/g, ""));
    return CompendiumHelper.findItems(DnD5eAdapter.getActivePacks(), {
      types: types?.length ? types : null,
      rarities: rarityNorms?.length ? rarityNorms : null,
      limit,
      excludeNames,
    });
  }

  /**
   * Create a spell scroll item data object from a spell document.
   * Exposed so the Quest Generator can convert dragged spells to scrolls.
   *
   * @param {Item} spellDoc
   * @returns {Promise<object|null>}
   */
  static async createScrollFromSpell(spellDoc) {
    return _createScrollFromSpellDoc(spellDoc);
  }
}

// Self-register when dnd5e is the active system
Hooks.once("init", () => {
  if (game.system.id === "dnd5e") {
    LootRoller.registerSystem(DnD5eAdapter);
  }
});
