/**
 * QuestGeneratorApp — interactive quest reward builder.
 *
 * The GM picks rarity and item type filters, then rolls one item at a time.
 * Each item can be added to the reward list or skipped. The accumulated list
 * can then be distributed via the lottery or saved for later.
 */

import { LootRoller }      from "../api.js";
import { LootListManager } from "../loot-list-manager.js";
import { LotterySetupApp } from "./lottery-setup-app.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class QuestGeneratorApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "quest-generator-app",
    classes: ["loot-roller", "quest-generator"],
    window: { title: "LOOTROLLER.quest.title", icon: "fa-solid fa-scroll", resizable: false },
    position: { width: 480, height: "auto" },
  };

  static PARTS = {
    content: { template: "modules/loot-roller/templates/quest-generator.hbs" },
  };

  constructor(options = {}) {
    const { onConfirm, ...superOptions } = options;
    super(superOptions);
    this._onConfirm  = onConfirm ?? null;  // optional callback from Quest Tracker integration
    this._rarities   = ["uncommon"];
    this._types      = [];            // empty = all types
    this._current    = null;          // current Item document or stub
    this._items      = [];            // accumulated reward list
    this._searching  = false;
    this._noResults  = false;
    this._rolled     = false;         // whether a roll has been attempted yet
  }

  async _prepareContext(options) {
    const adapter   = LootRoller.getAdapter();
    const rarities  = adapter?.getRarities?.()  ?? [];
    const itemTypes = adapter?.getItemTypes?.() ?? [];

    return {
      rarities,
      itemTypes,
      selectedRarities: this._rarities,
      selectedTypes:    this._types,
      current: this._current
        ? {
            name:   this._current.name,
            img:    this._current.img ?? "icons/svg/item-bag.svg",
            rarity: this._current.system?.rarity ?? this._current.rarity ?? "common",
            type:   this._current.type,
            stub:   !!this._current.stub,
          }
        : null,
      items: this._items.map((item, idx) => ({
        idx,
        name:     item.name,
        img:      item.img ?? "icons/svg/item-bag.svg",
        rarity:   item.system?.rarity ?? item.rarity ?? "common",
        stub:     !!item.stub,
        quantity: item.system?.quantity ?? 1,
      })),
      searching:        this._searching,
      noResults:        this._noResults,
      rolled:           this._rolled,
      hasAdapter:       !!adapter,
      questTrackerMode: !!this._onConfirm,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Rarity toggles (multi-select; at least one must remain selected)
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

    // Item type toggles
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

    this.element.querySelector("[data-action=roll-item]")
      ?.addEventListener("click", () => this._rollItem());

    this.element.querySelector("[data-action=add-item]")
      ?.addEventListener("click", () => this._addItem());

    this.element.querySelectorAll("[data-action=remove-item]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const idx = parseInt(btn.dataset.idx);
        this._items.splice(idx, 1);
        this.render(false);
      });
    });

    this.element.querySelector("[data-action=distribute]")
      ?.addEventListener("click", () => this._distribute());

    this.element.querySelector("[data-action=add-to-quest]")
      ?.addEventListener("click", () => this._addToQuest());

    this.element.querySelector("[data-action=save-list]")
      ?.addEventListener("click", () => this._saveList());

    // Quantity edits — write back into the stored plain-object so distribute/save carry it
    this.element.querySelectorAll(".item-qty-input").forEach((input) => {
      input.addEventListener("change", () => {
        const idx = parseInt(input.dataset.idx);
        const qty = Math.max(1, parseInt(input.value) || 1);
        const item = this._items[idx];
        if (item?.system) item.system.quantity = qty;
        input.value = qty;
      });
    });

    // Drag-and-drop from Compendium onto reward list
    const dropZone = this.element.querySelector(".reward-list-drop-zone");
    if (dropZone) {
      dropZone.addEventListener("dragover", (e) => {
        e.preventDefault();
        dropZone.classList.add("drag-over");
      });
      dropZone.addEventListener("dragleave", (e) => {
        if (!dropZone.contains(e.relatedTarget)) dropZone.classList.remove("drag-over");
      });
      dropZone.addEventListener("drop", async (e) => {
        e.preventDefault();
        dropZone.classList.remove("drag-over");
        await this._onDropItem(e);
      });
    }
  }

  async _onDropItem(event) {
    const data = TextEditor.getDragEventData(event);
    if (data.type !== "Item") return;
    const item = await fromUuid(data.uuid);
    if (!item) return;
    this._items.push(item.toObject());
    this.render(false);
  }

  async _rollItem() {
    const adapter = LootRoller.getAdapter();
    if (!adapter) return;

    this._searching = true;
    this._noResults = false;
    this._current   = null;
    this._rolled    = true;
    this.render(false);

    try {
      const types        = this._types.length ? this._types : null;
      const excludeNames = new Set(this._items.map((i) => i.name).filter(Boolean));
      const results      = await adapter.findItems({
        rarities: this._rarities,
        types,
        limit: 1,
        excludeNames,
      });

      if (results.length) {
        this._current   = results[0];
        this._noResults = false;
      } else {
        this._noResults = true;
      }
    } catch (err) {
      console.error("LootRoller | Quest roll error:", err);
      this._noResults = true;
    } finally {
      this._searching = false;
      this.render(false);
    }
  }

  async _addItem() {
    if (!this._current) return;
    this._items.push(this._current.toObject?.() ?? { ...this._current });
    this._current = null;
    this.render(false);
    await this._rollItem();
  }

  async _addToQuest() {
    if (!this._items.length) {
      ui.notifications.warn(game.i18n.localize("LOOTROLLER.quest.noItems"));
      return;
    }
    this._onConfirm(this._items);
    this.close();
  }

  async _distribute() {
    if (!this._items.length) {
      ui.notifications.warn(game.i18n.localize("LOOTROLLER.quest.noItems"));
      return;
    }
    this.close();
    new LotterySetupApp({ coins: {}, items: this._items }).render(true);
  }

  async _saveList() {
    if (!this._items.length) {
      ui.notifications.warn(game.i18n.localize("LOOTROLLER.quest.noItems"));
      return;
    }
    const name = await this._promptListName("");
    if (!name) return;
    await LootListManager.save(name, { items: this._items, category: "quest" });
    ui.notifications.info(game.i18n.format("LOOTROLLER.savedLists.saved", { name }));
  }

  /** Prompt the GM for a list name via a simple dialog. Returns null if cancelled. */
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
