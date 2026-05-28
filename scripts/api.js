/**
 * LootRoller global API
 *
 * Exposed as window.LootRoller after module init.
 * System adapters call LootRoller.registerSystem(MyAdapter) from their own
 * init hooks to plug in generation logic and compendium mappings.
 */

export const LootRoller = {
  /** @type {Map<string, typeof import('./systems/base-adapter.js').LootSystemAdapter>} */
  _adapters: new Map(),

  /**
   * Register a system adapter.
   * @param {typeof import('./systems/base-adapter.js').LootSystemAdapter} adapter
   */
  registerSystem(adapter) {
    if (!adapter.systemId) {
      console.error("LootRoller | registerSystem: adapter missing static systemId");
      return;
    }
    this._adapters.set(adapter.systemId, adapter);
    console.log(`LootRoller | Registered adapter for system: ${adapter.systemId}`);
  },

  /**
   * Retrieve the adapter for the active (or specified) system.
   * @param {string} [systemId]
   * @returns {typeof import('./systems/base-adapter.js').LootSystemAdapter | null}
   */
  getAdapter(systemId = game.system.id) {
    return this._adapters.get(systemId) ?? null;
  },

  /** Open the loot hub (main launcher). */
  openRoller() {
    const { LootHubApp } = game.modules.get("loot-roller").apps;
    new LootHubApp().render(true);
  },

  /**
   * Open the Quest Generator with a callback for Quest Tracker integration.
   * The GM rolls/picks items as normal; confirming calls onConfirm(items) instead
   * of opening the lottery setup, so the caller can save the items to a quest.
   *
   * @param {function(Array<Item>): void} onConfirm
   */
  openQuestRewards(onConfirm) {
    const { QuestGeneratorApp } = game.modules.get("loot-roller").apps;
    new QuestGeneratorApp({ onConfirm }).render(true);
  },

  /**
   * Open the LotterySetupApp pre-populated with items and coins.
   * Intended for external modules (e.g. Quest Tracker) to hand off resolved
   * loot directly into the lottery flow without going through the generator.
   *
   * @param {{ items: Array<Item>, coins?: Record<string, number> }} lootResult
   */
  startLottery({ items = [], coins = {} } = {}) {
    const { LotterySetupApp } = game.modules.get("loot-roller").apps;
    new LotterySetupApp({ items, coins }).render(true);
  },
};
