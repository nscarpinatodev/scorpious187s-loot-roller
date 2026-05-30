/**
 * ShopGeneratorApp — bulk shop inventory generator.
 *
 * The GM configures shop name, rarity mix, item type filters, and item count,
 * then generates the full inventory in one click. "Create Shop Actor" creates a
 * loot-type actor with the shop name and populates it with the generated items.
 */

import { LootRoller } from "../api.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class ShopGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "shop-generator-app",
    classes: ["loot-roller", "shop-generator"],
    window: { title: "LOOTROLLER.shop.title", icon: "fa-solid fa-shop", resizable: false },
    position: { width: 500, height: "auto" },
  };

  static PARTS = {
    content: { template: "modules/loot-roller/templates/shop-generator.hbs" },
  };

  constructor(options = {}) {
    super(options);
    this._shopName   = "";
    this._rarities   = ["common", "uncommon"];
    this._types      = [];
    this._partyLevel = null;   // party level for PF2e; null = use rarity
    this._itemCount  = 10;
    this._items      = [];
    this._generating = false;
  }

  async _prepareContext(options) {
    const adapter       = LootRoller.getAdapter();
    const rarities      = adapter?.getRarities?.()       ?? [];
    const itemTypes     = adapter?.getItemTypes?.()      ?? [];
    const levelRangeDef = adapter?.getItemLevelRange?.() ?? null;

    // Seed default party level from adapter on first load
    if (levelRangeDef && this._partyLevel === null) {
      this._partyLevel = levelRangeDef.default;
    }

    return {
      rarities,
      itemTypes,
      usesPartyLevel:   !!levelRangeDef,
      levelRangeDef,
      partyLevel:       this._partyLevel,
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

    // Party level input (PF2e — shown instead of rarity buttons)
    this.element.querySelector(".quest-party-level")?.addEventListener("change", (e) => {
      this._partyLevel = Math.min(20, Math.max(1, parseInt(e.target.value) || 1));
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

    this.element.querySelector("[data-action=create-shop]")
      ?.addEventListener("click", () => this._createShop());

  }

  async _generate() {
    const adapter = LootRoller.getAdapter();
    if (!adapter) return;

    this._generating = true;
    this._items      = [];
    this.render(false);

    try {
      const types      = this._types.length ? this._types : null;
      const findParams = { types, limit: this._itemCount };
      if (this._partyLevel !== null) {
        findParams.partyLevel = this._partyLevel;
      } else {
        findParams.rarities = this._rarities;
      }
      this._items   = await adapter.findItems(findParams);
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
