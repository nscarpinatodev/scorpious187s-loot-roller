/**
 * LotterySetupApp — GM interface for sorting generated loot.
 *
 * Shows all rolled items and coins. GM assigns each item to one of:
 *   lottery — players roll off for it
 *   stash   — goes directly to the party stash actor
 *   discard — dropped from this session
 *
 * Destinations are tracked in this._destinations (idx → string) rather than
 * radio inputs, because Foundry's form event handling interferes with
 * radio change events in ApplicationV2.
 */

import { LotteryManager } from "../lottery-manager.js";
import { LotteryGMApp }   from "./lottery-gm-app.js";
import { LootListManager } from "../loot-list-manager.js";
import { formatCoins }    from "../currency-helper.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

export class LotterySetupApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "lottery-setup-app",
    classes: ["loot-roller", "lottery-setup"],
    tag: "form",
    form: { handler: LotterySetupApp.#onSubmit, submitOnChange: false, closeOnSubmit: false },
    window: { title: "LOOTROLLER.lottery.setupTitle", icon: "fa-solid fa-dice-d20", resizable: true },
    position: { width: 560, height: "auto", top: 100 },
  };

  static PARTS = {
    form: { template: "modules/loot-roller/templates/lottery-setup.hbs" },
  };

  /** @param {{ coins: object, items: Array }} lootResult */
  constructor(lootResult, options = {}) {
    super(options);
    this._lootResult = lootResult;
    /** @type {Record<number, "lottery"|"stash"|"discard">} */
    this._destinations = {};
    /** @type {Record<number, boolean>} idx → true = mystified (unidentified for players) */
    this._mystified = {};
    /** @type {"equal"|"stash"} */
    this._currencyMode = game.settings.get("loot-roller", "currencyDistribution") ?? "equal";

    // Seed mystified state from item data (rare+ items auto-mystified by resolveItems)
    lootResult.items.forEach((item, idx) => {
      if (item.system?.identified === false) this._mystified[idx] = true;
    });
  }

  async _prepareContext(options) {
    const { coins, items } = this._lootResult;
    const stashUuid  = game.settings.get("loot-roller", "partyStashActor");
    const stashActor = stashUuid ? await fromUuid(stashUuid) : null;

    return {
      coins,
      formattedCoins: formatCoins(coins),
      hasCoins:       Object.values(coins).some((v) => v > 0),
      currencyMode:   this._currencyMode,
      items: items.map((item, idx) => ({
        idx,
        name:        item.name ?? "Unknown Item",
        img:         item.img  ?? "icons/svg/item-bag.svg",
        rarity:      item.system?.rarity ?? item.rarity ?? "",
        stub:        !!item.stub,
        dest:        this._destinations[idx] ?? "lottery",
        mystified:   this._mystified[idx] ?? false,
        sourceUuid:  item._sourceUuid ?? item.uuid ?? null,
      })),
      stashActorName: stashActor?.name ?? null,
      hasStash:       !!stashActor,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    // Destination buttons
    this.element.querySelectorAll("[data-action=set-dest]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const idx  = parseInt(btn.dataset.idx);
        const dest = btn.dataset.dest;
        this._destinations[idx] = dest;
        btn.closest(".item-destination").querySelectorAll(".dest-btn").forEach((b) => {
          b.classList.toggle("selected", b === btn);
        });
      });
    });

    // Mystify toggle buttons
    this.element.querySelectorAll("[data-action=toggle-mystify]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        const idx = parseInt(btn.dataset.idx);
        this._mystified[idx] = !(this._mystified[idx] ?? false);
        this.render(false);
      });
    });

    // View item card (GM only)
    this.element.querySelectorAll("[data-action=view-item]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.preventDefault();
        const idx = parseInt(btn.dataset.idx);
        await _openItemSheet(this._lootResult.items[idx]);
      });
    });

    // Currency mode buttons
    this.element.querySelectorAll("[data-action=set-currency]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this._currencyMode = btn.dataset.mode;
        this.element.querySelectorAll("[data-action=set-currency]").forEach((b) => {
          b.classList.toggle("selected", b === btn);
        });
      });
    });

    // Save list for later
    this.element.querySelector("[data-action=save-list]")?.addEventListener("click", (e) => {
      e.preventDefault();
      this.#saveList();
    });
  }

  async #saveList() {
    const { items } = this._lootResult;
    if (!items.length) {
      ui.notifications.warn(game.i18n.localize("LOOTROLLER.quest.noItems"));
      return;
    }

    const name = await Dialog.prompt({
      title: game.i18n.localize("LOOTROLLER.savedLists.namePrompt"),
      content: `<div class="form-group">
        <label>${game.i18n.localize("LOOTROLLER.savedLists.nameLabel")}</label>
        <input type="text" name="listName" autofocus />
      </div>`,
      label: game.i18n.localize("LOOTROLLER.savedLists.save"),
      callback: (html) => html.find("[name=listName]").val().trim(),
      options: { width: 320 },
    }).catch(() => null);

    if (!name) return;
    await LootListManager.save(name, { items, coins: this._lootResult.coins ?? {}, category: "custom" });
    ui.notifications.info(game.i18n.format("LOOTROLLER.savedLists.saved", { name }));
  }

  static async #onSubmit(event, form, formData) {
    const app = /** @type {LotterySetupApp} */ (this);

    const { items } = app._lootResult;
    const lotteryItems = [];
    const stashItems   = [];

    for (let i = 0; i < items.length; i++) {
      const dest = app._destinations[i] ?? "lottery";
      if (dest === "discard") continue;

      // Serialize to plain object so we can apply the mystify state
      const raw  = items[i];
      const data = raw.toObject?.() ?? { ...raw };
      delete data._id;
      if (data.system) data.system.identified = !(app._mystified[i] ?? false);

      if (dest === "lottery") lotteryItems.push(data);
      else if (dest === "stash") stashItems.push(data);
    }

    if (lotteryItems.length === 0 && stashItems.length === 0) {
      ui.notifications.warn("LOOTROLLER.warn.noItemsSelected", { localize: true });
      return;
    }

    const manager = new LotteryManager();
    game.modules.get("loot-roller").lotteryManager = manager;

    const gmApp = new LotteryGMApp(manager);
    game.modules.get("loot-roller").lotteryGMApp = gmApp;

    app.close();

    await manager.start({
      lotteryItems,
      stashItems,
      coins:        app._lootResult.coins,
      currencyMode: app._currencyMode,
    });

    gmApp.render(true);
  }
}

/** Open an item sheet for any item — document, plain object, or UUID-backed data. */
async function _openItemSheet(item) {
  if (!item) return;
  const uuid = item._sourceUuid ?? item.uuid;
  if (uuid) {
    const doc = await fromUuid(uuid).catch(() => null);
    if (doc) { doc.sheet.render(true); return; }
  }
  // Fallback: temporary in-memory item
  const data = item.toObject?.() ?? { ...item };
  delete data._id;
  const temp = new CONFIG.Item.documentClass(data);
  temp.sheet.render(true);
}
