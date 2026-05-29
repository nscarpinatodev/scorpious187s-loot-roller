/**
 * LotteryManager — GM-side state machine for the item roll-off system.
 *
 * One instance lives per lottery session. The GM client is authoritative;
 * players submit responses via sockets which the GM aggregates here.
 *
 * States: IDLE → ROLLING → RESOLVING_TIE → COMPLETE
 */

import { emit, MSG } from "./socket.js";
import { addCurrencyToActor, splitEqually, formatCoins } from "./currency-helper.js";
import { LootRoller } from "./api.js";

const STATE = Object.freeze({
  IDLE: "idle",
  ROLLING: "rolling",
  RESOLVING_TIE: "resolvingTie",
  COMPLETE: "complete",
});

export class LotteryManager {
  constructor() {
    this.state = STATE.IDLE;
    /** @type {Array<Item>} Items in the lottery queue. */
    this._queue = [];
    /** @type {number} Index into _queue for the current item. */
    this._currentIndex = 0;
    /** @type {Map<string, {roll?:number, pass?:boolean}>} userId → response */
    this._responses = new Map();
    /** @type {Set<string>} userIds of players still eligible to roll. */
    this._eligiblePlayers = new Set();
    /** @type {number|null} Timeout handle for forced roll. */
    this._timeoutHandle = null;
    /** @type {Array<{item:Item, winnerId:string, winnerName:string}>} Full lottery summary. */
    this._summary = [];
    /** @type {object} Coins to be distributed. */
    this._coins = {};
    /** @type {string} Currency distribution mode: "equal" | "stash" */
    this._currencyMode = "equal";
    /** @type {Array<Item>} Items going directly to party stash. */
    this._stashItems = [];
  }

  /**
   * Begin the lottery session.
   *
   * @param {{
   *   lotteryItems: Item[],
   *   stashItems:   Item[],
   *   coins:        object,
   *   currencyMode: string
   * }} config
   */
  async start(config) {
    if (this.state !== STATE.IDLE) return;

    this._queue = config.lotteryItems ?? [];
    this._stashItems = config.stashItems ?? [];
    this._coins = config.coins ?? {};
    this._currencyMode = config.currencyMode ?? "equal";
    this._currentIndex = 0;
    this._summary = [];

    // Only players with an assigned character sheet can participate
    this._eligiblePlayers = new Set(
      game.users
        .filter((u) => u.active && !u.isGM && u.character)
        .map((u) => u.id)
    );

    await this._processStashItems();
    await this._distributeCurrency();

    if (this._queue.length === 0) {
      await this._complete();
      return;
    }

    this.state = STATE.ROLLING;
    this._processNextItem();
  }

  /** Record a player's response for the current item. */
  recordResponse(userId, response) {
    if (this.state !== STATE.ROLLING && this.state !== STATE.RESOLVING_TIE) return;
    if (!this._eligiblePlayers.has(userId)) return;

    this._responses.set(userId, response);
    game.modules.get("loot-roller").lotteryGMApp?.refresh();

    if (this._responses.size >= this._eligiblePlayers.size) {
      clearTimeout(this._timeoutHandle);
      this._resolveCurrentItem();
    }
  }

  /** Return a plain-object snapshot of current state for the GM monitor app. */
  getGMState() {
    const currentDoc = this._queue[this._currentIndex];
    const currentItem = currentDoc ? {
      name: currentDoc.name,
      img: currentDoc.img ?? "icons/svg/item-bag.svg",
      rarity: currentDoc.system?.rarity ?? currentDoc.rarity ?? "",
    } : null;

    const upcoming = this._queue.slice(this._currentIndex + 1).map((item) => ({
      name: item.name,
      img: item.img ?? "icons/svg/item-bag.svg",
    }));

    const playerStatuses = [...this._eligiblePlayers].map((userId) => {
      const user = game.users.get(userId);
      const response = this._responses.get(userId);
      let statusClass, icon, label;
      if (!response) {
        statusClass = "waiting";
        icon = "fa-hourglass-half";
        label = game.i18n.localize("LOOTROLLER.lottery.statusWaiting");
      } else if (response.pass) {
        statusClass = "passed";
        icon = "fa-forward";
        label = game.i18n.localize("LOOTROLLER.lottery.statusPassed");
      } else {
        statusClass = "rolled";
        icon = "fa-dice-d20";
        label = game.i18n.format("LOOTROLLER.lottery.statusRolled", { n: response.roll });
      }
      return { userId, name: user?.name ?? userId, statusClass, icon, label };
    });

    return {
      currentItem,
      upcoming,
      currentIndex: this._currentIndex + 1,
      total: this._queue.length,
      playerStatuses,
      state: this.state,
      isTieBreaker: this.state === STATE.RESOLVING_TIE,
      canForceResolve: this.state === STATE.ROLLING || this.state === STATE.RESOLVING_TIE,
    };
  }

  /**
   * GM manually forces the current item to resolve.
   * Any player who hasn't responded is treated as a pass.
   */
  forceResolve() {
    if (this.state !== STATE.ROLLING && this.state !== STATE.RESOLVING_TIE) return;
    clearTimeout(this._timeoutHandle);
    this._resolveCurrentItem();
  }

  // ── Private ──────────────────────────────────────────────────────────────

  _processNextItem() {
    if (this._currentIndex >= this._queue.length) {
      this._complete();
      return;
    }

    this._responses.clear();
    const item = this._queue[this._currentIndex];

    const isUnidentified   = item.system?.identified === false;
    const displayName      = isUnidentified
      ? (item.system?.unidentified?.name || game.i18n.localize("LOOTROLLER.lottery.unidentifiedItem"))
      : item.name;
    const displayDesc      = isUnidentified
      ? (item.system?.unidentified?.description || "")
      : (item.system?.description?.value || "");

    emit(MSG.ITEM_UP_FOR_ROLL, {
      itemId:          item.id ?? item._id,
      itemName:        displayName,
      itemImg:         item.img,
      itemType:        item.type,
      itemDescription: displayDesc,
      round:           this._currentIndex + 1,
      total:           this._queue.length,
    });

    game.modules.get("loot-roller").lotteryGMApp?.refresh();

    const timeout = game.settings.get("loot-roller", "lotteryTimeout");
    if (timeout > 0) {
      this._timeoutHandle = setTimeout(() => this.forceResolve(), timeout * 1000);
    }
  }

  _resolveCurrentItem() {
    const item = this._queue[this._currentIndex];
    const rollers = [];

    for (const [userId, response] of this._responses) {
      if (!response.pass && response.roll != null) {
        rollers.push({ userId, roll: response.roll });
      }
    }

    // All passed — send to stash instead
    if (rollers.length === 0) {
      this._stashItems.push(item);
      this._addItemToStash(item);
      this._announceResult(item, null, null, "passed");
      this._advance();
      return;
    }

    const maxRoll = Math.max(...rollers.map((r) => r.roll));
    const winners = rollers.filter((r) => r.roll === maxRoll);

    if (winners.length > 1) {
      // Tie — restrict eligible players and re-roll
      this._eligiblePlayers = new Set(winners.map((w) => w.userId));
      this._responses.clear();
      this.state = STATE.RESOLVING_TIE;

      emit(MSG.TIE_BREAKER, {
        itemId: item.id ?? item._id,
        itemName: item.name,
        itemImg: item.img,
        tiedPlayerIds: [...this._eligiblePlayers],
      });

      const timeout = game.settings.get("loot-roller", "lotteryTimeout");
      if (timeout > 0) {
        this._timeoutHandle = setTimeout(() => this.forceResolve(), timeout * 1000);
      }
      return;
    }

    // Clear winner
    const winner = winners[0];
    const winnerUser = game.users.get(winner.userId);
    const winnerActor = winnerUser?.character;

    if (winnerActor) {
      this._addItemToActor(winnerActor, item);
    }

    this._summary.push({ item, winnerId: winner.userId, winnerName: winnerUser?.name ?? "Unknown" });
    this._announceResult(item, winner.userId, winnerUser?.name, "won", maxRoll);

    // Reset eligible players to full pool for next item
    this._eligiblePlayers = new Set(
      game.users
        .filter((u) => u.active && !u.isGM && u.character)
        .map((u) => u.id)
    );
    this.state = STATE.ROLLING;
    this._advance();
  }

  _advance() {
    this._currentIndex++;
    this._processNextItem();
  }

  async _addItemToActor(actor, item) {
    try {
      const itemData = item.toObject ? item.toObject() : { ...item };
      delete itemData._id;
      await actor.createEmbeddedDocuments("Item", [itemData]);
    } catch (err) {
      console.error(`LootRoller | Failed to add ${item.name} to ${actor.name}:`, err);
    }
  }

  async _addItemToStash(item) {
    const stashUuid = game.settings.get("loot-roller", "partyStashActor");
    if (!stashUuid) return;
    const stash = await fromUuid(stashUuid);
    if (stash) await this._addItemToActor(stash, item);
  }

  async _processStashItems() {
    const stashUuid = game.settings.get("loot-roller", "partyStashActor");
    if (!stashUuid || !this._stashItems.length) return;
    const stash = await fromUuid(stashUuid);
    if (!stash) return;
    for (const item of this._stashItems) {
      await this._addItemToActor(stash, item);
    }
  }

  async _distributeCurrency() {
    if (!Object.values(this._coins).some((v) => v > 0)) return;

    if (this._currencyMode === "stash") {
      const stashUuid = game.settings.get("loot-roller", "partyStashActor");
      if (stashUuid) {
        const stash = await fromUuid(stashUuid);
        if (stash) await addCurrencyToActor(stash, this._coins);
      }
      return;
    }

    // Equal split among active players with characters
    const players = game.users.filter((u) => u.active && !u.isGM && u.character);
    if (!players.length) return;

    const { perPlayer, remainder } = splitEqually(this._coins, players.length);

    for (const user of players) {
      if (user.character) await addCurrencyToActor(user.character, perPlayer);
    }

    // Remainder goes to stash if configured
    const stashUuid = game.settings.get("loot-roller", "partyStashActor");
    if (stashUuid && Object.values(remainder).some((v) => v > 0)) {
      const stash = await fromUuid(stashUuid);
      if (stash) await addCurrencyToActor(stash, remainder);
    }

    ChatMessage.create({
      content: game.i18n.format("LOOTROLLER.chat.currencyDistributed", {
        perPlayer: formatCoins(perPlayer),
        count: players.length,
      }),
      whisper: ChatMessage.getWhisperRecipients("GM"),
    });
  }

  _announceResult(item, winnerId, winnerName, outcome, roll) {
    emit(MSG.ITEM_RESOLVED, { itemName: item.name, winnerId, winnerName, outcome, roll });

    let content;
    if (outcome === "passed") {
      content = game.i18n.format("LOOTROLLER.chat.itemPassed", { item: item.name });
    } else {
      content = game.i18n.format("LOOTROLLER.chat.itemWon", { item: item.name, player: winnerName, roll });
    }
    ChatMessage.create({ content });
  }

  async _complete() {
    this.state = STATE.COMPLETE;
    game.modules.get("loot-roller").lotteryGMApp?.close();
    emit(MSG.LOTTERY_COMPLETE, { summary: this._summary.map((s) => ({ itemName: s.item.name, winnerName: s.winnerName })) });

    // Final summary chat card
    const adapter = LootRoller.getAdapter();
    const content = await renderTemplate("modules/loot-roller/templates/chat-loot.hbs", {
      coins: this._coins,
      formattedCoins: formatCoins(this._coins),
      summary: this._summary,
      stashItems: this._stashItems,
      currencyMode: this._currencyMode,
    });
    ChatMessage.create({ content });
  }
}
