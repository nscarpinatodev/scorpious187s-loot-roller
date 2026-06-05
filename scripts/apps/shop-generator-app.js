/**
 * ShopGeneratorApp — bulk shop inventory generator.
 *
 * The GM configures shop name, rarity mix, item type filters, and item count,
 * then generates the full inventory in one click. "Create Shop Actor" creates a
 * loot-type actor with the shop name and populates it with the generated items.
 */

import { LootRoller } from "../api.js";
import { ItemDetailApp } from "./item-detail-app.js";
import { bindRowClicks } from "../row-click.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

// Customizable Shop integration — shop vendors are actors flagged isShop by it.
const CS_ID        = "scorpious187s-customizable-shop";
const CS_FLAG_SHOP = "isShop";
const CS_FLAG_NAME = "shopName";

export class ShopGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "shop-generator-app",
    classes: ["loot-roller", "shop-generator"],
    window: { title: "LOOTROLLER.shop.title", icon: "fa-solid fa-shop", resizable: false },
    position: { width: 500, height: "auto" },
  };

  static PARTS = {
    content: { template: "modules/scorpious187s-loot-roller/templates/shop-generator.hbs" },
  };

  constructor(options = {}) {
    super(options);
    this._shopName   = "";
    this._rarities   = ["common", "uncommon"];
    this._types      = [];
    this._levelRange = null;   // [low, high] item-level window for PF2e; null = use rarity
    this._itemCount  = 10;
    this._items      = [];
    this._generating = false;
  }

  async _prepareContext(options) {
    const adapter   = LootRoller.getAdapter();
    const itemTypes = adapter?.getItemTypes?.() ?? [];

    // Seed the level range from the adapter default on first open (PF2e only)
    if (this._levelRange === null && adapter?.getItemLevelRange && adapter?.partyLevelToItemRange) {
      const def = adapter.getItemLevelRange().default ?? 5;
      this._levelRange = adapter.partyLevelToItemRange(def);
    }

    const filterState  = { mode: "shop", selectedRarities: this._rarities, levelRange: this._levelRange ?? undefined };
    const filterFields = adapter?.getFilterFields?.(filterState) ?? [{
      type:    "rarity-buttons",
      key:     "rarities",
      label:   "LOOTROLLER.shop.rarities",
      options: (adapter?.getRarities?.() ?? []).map((r) => ({
        value:    r.value,
        label:    r.label,
        selected: this._rarities.includes(r.value),
      })),
    }];

    return {
      itemTypes,
      filterFields,
      shopName:         this._shopName,
      selectedRarities: this._rarities,
      selectedTypes:    this._types,
      itemCount:        this._itemCount,
      items: this._items.map((item, idx) => ({
        idx,
        name:   item.name,
        img:    item.img ?? "icons/svg/item-bag.svg",
        rarity: item.system?.traits?.rarity ?? item.system?.rarity ?? item.rarity ?? "common",
        level:  item.system?.level?.value   ?? null,
        stub:   !!item.stub,
      })),
      generating: this._generating,
      hasItems:   this._items.length > 0,
      hasAdapter: !!adapter,
      canRestock: !!game.modules.get(CS_ID)?.active,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    const nameInput = this.element.querySelector("[name=shopName]");
    if (nameInput) {
      nameInput.addEventListener("input", (e) => { this._shopName = e.target.value; });
    }

    const countInput = this.element.querySelector("[name=itemCount]");
    if (countInput) {
      countInput.addEventListener("input", (e) => {
        this._itemCount = Math.max(1, Math.min(50, parseInt(e.target.value) || 10));
      });
    }

    this.element.querySelectorAll("[data-action=toggle-rarity]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const rarity = btn.dataset.rarity;
        if (this._rarities.includes(rarity)) {
          if (this._rarities.length > 1) this._rarities = this._rarities.filter((r) => r !== rarity);
        } else {
          this._rarities.push(rarity);
        }
        this.render(false);
      });
    });

    // Low/High item-level dual slider (PF2e Shop Generator)
    this._initLevelRangeSlider();

    this.element.querySelectorAll("[data-action=toggle-type]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const type = btn.dataset.itemType;
        if (this._types.includes(type)) {
          this._types = this._types.filter((t) => t !== type);
        } else {
          this._types.push(type);
        }
        this.render(false);
      });
    });


    this.element.querySelector("[data-action=generate]")
      ?.addEventListener("click", () => this._generate());

    this.element.querySelectorAll("[data-action=remove-item]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx);
        this._items.splice(idx, 1);
        this.render(false);
      });
    });

    // View an inventory item's details in the module's detail popup (GM tool → real details).
    this.element.querySelectorAll("[data-action=view-item]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const idx  = parseInt(btn.dataset.idx);
        const item = this._items[idx];
        if (!item) return;
        const uuid = item._sourceUuid ?? item.uuid;
        const doc  = uuid ? await fromUuid(uuid).catch(() => null) : null;
        ItemDetailApp.show({ item: doc ?? item, mystified: false });
      });
    });

    // Whole-row click opens the same detail popup as the image button.
    bindRowClicks(this.element);

    this.element.querySelector("[data-action=create-shop]")
      ?.addEventListener("click", () => this._createShop());

    this.element.querySelector("[data-action=restock-shop]")
      ?.addEventListener("click", () => this._restockShop());

    this.element.querySelector("[data-action=clear-inventory]")
      ?.addEventListener("click", () => {
        this._items = [];
        this.render(false);
      });

  }

  /**
   * Wire up the dual-handle low/high item-level slider. Updates this._levelRange
   * and repaints the fill + value readouts live on drag, without a full re-render
   * (a re-render would interrupt the drag).
   */
  _initLevelRangeSlider() {
    const slider = this.element.querySelector(".level-range-slider");
    if (!slider) return;

    const lowEl   = slider.querySelector(".level-range-low");
    const highEl  = slider.querySelector(".level-range-high");
    const fill    = slider.querySelector(".level-range-fill");
    const lowVal  = slider.querySelector(".level-range-value-low");
    const highVal = slider.querySelector(".level-range-value-high");
    if (!lowEl || !highEl) return;

    const min  = parseInt(slider.dataset.min) || 0;
    const max  = parseInt(slider.dataset.max) || 30;
    const span = (max - min) || 1;

    const paint = () => {
      const lo = parseInt(lowEl.value);
      const hi = parseInt(highEl.value);
      if (fill) {
        fill.style.left  = `${((lo - min) / span) * 100}%`;
        fill.style.right = `${100 - ((hi - min) / span) * 100}%`;
      }
      if (lowVal)  lowVal.textContent  = lo;
      if (highVal) highVal.textContent = hi;
      this._levelRange = [lo, hi];
    };

    lowEl.addEventListener("input", () => {
      if (parseInt(lowEl.value) > parseInt(highEl.value)) highEl.value = lowEl.value;
      paint();
    });
    highEl.addEventListener("input", () => {
      if (parseInt(highEl.value) < parseInt(lowEl.value)) lowEl.value = highEl.value;
      paint();
    });

    paint(); // initial fill + readout
  }

  async _generate() {
    const adapter = LootRoller.getAdapter();
    if (!adapter) return;

    this._generating = true;
    this.render(false);

    try {
      const types      = this._types.length ? this._types : null;
      const findParams = { types, limit: this._itemCount };
      if (Array.isArray(this._levelRange)) {
        findParams.levelRange = this._levelRange;
      } else {
        findParams.rarities = this._rarities;
      }
      const newItems = await adapter.findItems(findParams);
      this._items.push(...newItems);
    } catch (err) {
      console.error("LootRoller | Shop generation error:", err);
    } finally {
      this._generating = false;
      this.render(false);
    }
  }

  async _createShop() {
    if (!this._items.length) {
      ui.notifications.warn(game.i18n.localize("LOOTROLLER.shop.noItems"));
      return;
    }

    // Use the shop name as-is, or prompt if blank
    let name = this._shopName.trim();
    if (!name) {
      name = await this._promptListName("");
      if (!name) return;
      this._shopName = name;
    }

    // game.documentTypes.Actor is an array in Foundry v13, an object in v12.
    const actorTypesRaw = game.documentTypes?.Actor ?? [];
    const actorTypes    = Array.isArray(actorTypesRaw)
      ? actorTypesRaw
      : Object.keys(actorTypesRaw);
    const shopType = actorTypes.find((t) => t === "loot")
      ?? actorTypes.find((t) => t === "npc")
      ?? actorTypes.find((t) => t !== "base")
      ?? "npc";

    const actor = await Actor.create({ name, type: shopType });
    if (!actor) {
      ui.notifications.error(game.i18n.localize("LOOTROLLER.shop.createFailed"));
      return;
    }

    // Populate the actor with items
    const itemData = this._items.map((item) => {
      if (item?.toObject) {
        const obj = item.toObject();
        delete obj._id;
        return obj;
      }
      return { ...item };
    });

    if (itemData.length) {
      await actor.createEmbeddedDocuments("Item", itemData);
    }

    ui.notifications.info(game.i18n.format("LOOTROLLER.shop.created", { name, count: itemData.length }));
    actor.sheet?.render(true);
    this.close();
  }

  /**
   * Restock an existing Customizable Shop vendor — append the generated items to
   * the chosen vendor actor, stacking quantity when an item it already carries is
   * generated again. Leaves the generator open so several vendors can be restocked.
   */
  async _restockShop() {
    if (!this._items.length) {
      ui.notifications.warn(game.i18n.localize("LOOTROLLER.shop.noItems"));
      return;
    }

    const vendors = ShopGeneratorApp._getShopVendors();
    if (!vendors.length) {
      ui.notifications.warn(game.i18n.localize("LOOTROLLER.shop.restockNoVendors"));
      return;
    }

    const actorId = await this._promptVendor(vendors);
    if (!actorId) return;
    const actor = game.actors.get(actorId);
    if (!actor) return;

    let result;
    try {
      result = await ShopGeneratorApp._addItemsToActor(actor, this._items);
    } catch (err) {
      console.error("LootRoller | Restock failed:", err);
      ui.notifications.error(game.i18n.localize("LOOTROLLER.shop.restockFailed"));
      return;
    }

    ui.notifications.info(game.i18n.format("LOOTROLLER.shop.restocked", {
      name:    actor.getFlag(CS_ID, CS_FLAG_NAME) || actor.name,
      added:   result.created,
      stacked: result.restocked,
    }));
  }

  /** Owned actors flagged as shops by the Customizable Shop module, name-sorted. */
  static _getShopVendors() {
    if (!game.modules.get(CS_ID)?.active) return [];
    return game.actors
      .filter((a) => a.isOwner && a.getFlag(CS_ID, CS_FLAG_SHOP))
      .map((a) => ({ id: a.id, label: a.getFlag(CS_ID, CS_FLAG_NAME) || a.name }))
      .sort((x, y) => x.label.localeCompare(y.label));
  }

  /** Prompt the GM to choose a vendor; resolves to an actor id or null. */
  async _promptVendor(vendors) {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const options = vendors.map((v) => `<option value="${v.id}">${esc(v.label)}</option>`).join("");
    return Dialog.prompt({
      title: game.i18n.localize("LOOTROLLER.shop.restockTitle"),
      content: `<div class="form-group">
        <label>${game.i18n.localize("LOOTROLLER.shop.restockSelectLabel")}</label>
        <select name="vendor" style="width:100%">${options}</select>
      </div>`,
      label: game.i18n.localize("LOOTROLLER.shop.restockButton"),
      callback: (html) => html.find("[name=vendor]").val(),
      options: { width: 360 },
      rejectClose: false,
    }).catch(() => null);
  }

  /**
   * Append generated items to an actor, stacking onto matching existing items.
   * Matches by compendium source first, then by name + type.
   * @returns {Promise<{created:number, restocked:number}>}
   */
  static async _addItemsToActor(actor, items) {
    const existing = actor.items.contents;
    const matchFor = (data) => {
      const sk = ShopGeneratorApp._sourceKey(data);
      if (sk) {
        const bySource = existing.find((e) => ShopGeneratorApp._sourceKey(e) === sk);
        if (bySource) return bySource;
      }
      const nk = ShopGeneratorApp._nameKey(data);
      return existing.find((e) => ShopGeneratorApp._nameKey(e) === nk);
    };

    const toCreate = [];
    const newQty   = new Map(); // existing item id → accumulated quantity

    for (const item of items) {
      const data = item?.toObject ? item.toObject() : foundry.utils.deepClone(item);
      delete data._id;
      // Record the source uuid so future restocks stack precisely.
      const srcUuid = item?._sourceUuid ?? item?.uuid ?? null;
      if (srcUuid && !foundry.utils.getProperty(data, "flags.core.sourceId")) {
        foundry.utils.setProperty(data, "flags.core.sourceId", srcUuid);
      }

      const addQty = ShopGeneratorApp._getQty(data);
      const match  = matchFor(data);
      if (match) {
        const base = newQty.has(match.id) ? newQty.get(match.id) : ShopGeneratorApp._getQty(match);
        newQty.set(match.id, base + addQty);
      } else {
        toCreate.push(data);
      }
    }

    if (newQty.size) {
      const updates = [...newQty.entries()].map(([id, qty]) => {
        const obj = { _id: id };
        foundry.utils.setProperty(obj, ShopGeneratorApp._qtyPath(actor.items.get(id)), qty);
        return obj;
      });
      await actor.updateEmbeddedDocuments("Item", updates);
    }
    if (toCreate.length) await actor.createEmbeddedDocuments("Item", toCreate);

    return { created: toCreate.length, restocked: newQty.size };
  }

  /** Stable identity for stacking: compendium source, falling back to a uuid. */
  static _sourceKey(it) {
    return foundry.utils.getProperty(it, "_stats.compendiumSource")
      ?? foundry.utils.getProperty(it, "flags.core.sourceId")
      ?? it?._sourceUuid ?? it?.uuid ?? null;
  }

  /** Fallback identity: lower-cased name + type. */
  static _nameKey(it) {
    return `${(it?.name ?? "").toLowerCase()}::${it?.type ?? ""}`;
  }

  /** System-aware quantity path (number vs {value}). */
  static _qtyPath(it) {
    const q = foundry.utils.getProperty(it, "system.quantity");
    return (typeof q === "object" && q !== null) ? "system.quantity.value" : "system.quantity";
  }

  /** Current quantity of an item/data, defaulting to 1. */
  static _getQty(it) {
    return Number(foundry.utils.getProperty(it, ShopGeneratorApp._qtyPath(it))) || 1;
  }

  async _promptListName(defaultValue = "") {
    return Dialog.prompt({
      title: game.i18n.localize("LOOTROLLER.savedLists.namePrompt"),
      content: `<div class="form-group">
        <label>${game.i18n.localize("LOOTROLLER.savedLists.nameLabel")}</label>
        <input type="text" name="listName" value="${defaultValue}" autofocus />
      </div>`,
      label: game.i18n.localize("LOOTROLLER.savedLists.save"),
      callback: (html) => html.find("[name=listName]").val().trim(),
      options: { width: 320 },
    }).catch(() => null);
  }
}
