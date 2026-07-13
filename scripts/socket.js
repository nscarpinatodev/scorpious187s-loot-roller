/**
 * Socket layer for Loot Roller.
 *
 * All messages flow through the single "module.scorpious187s-loot-roller"
 * channel with the family message shape { type, payload, senderId }; the
 * plumbing is the shared library's socket router.
 *
 * Handlers run on every client and branch on role explicitly: lottery state
 * lives on the GM client that STARTED the lottery (mod.lotteryManager), which
 * is not necessarily the primary GM — so these must not be primary-GM-gated.
 *
 * Direction key:
 *   GM → All   : broadcast to every connected client
 *   Player → GM: routed to the GM's client (the GM aggregates responses)
 */

export const MSG = Object.freeze({
  /** GM → All: an item is now open for lottery rolling. */
  ITEM_UP_FOR_ROLL: "itemUpForRoll",
  /** GM → subset: tie-breaker — only tied players re-roll. */
  TIE_BREAKER: "tieBreaker",
  /** Player → GM: the player rolled this value. */
  PLAYER_ROLL: "playerRoll",
  /** Player → GM: the player is passing on this item. */
  PLAYER_PASS: "playerPass",
  /** GM → All: this item was awarded to a winner. */
  ITEM_RESOLVED: "itemResolved",
  /** GM → All: all lottery items have been processed. */
  LOTTERY_COMPLETE: "lotteryComplete",
});

const MODULE_ID = "scorpious187s-loot-roller";
const LIB_ID = "scorpious187s-lib";

let _router = null;

/**
 * Emit a socket message.
 * @param {string} type  One of MSG.*
 * @param {object} payload
 */
export function emit(type, payload = {}) {
  if (_router) _router.emit(type, payload);
  else game.socket.emit(`module.${MODULE_ID}`, { type, payload, senderId: game.user.id });
}

const gmManager = () => game.modules.get(MODULE_ID).lotteryManager;
const playerApp = () => game.modules.get(MODULE_ID).apps?.LotteryPlayerApp;

/**
 * Register the socket listener. Called once from main.js init hook.
 */
export function registerSocketHandlers() {
  const lib = game.modules.get(LIB_ID)?.api;
  if (!lib) {
    console.error(`LootRoller | ${LIB_ID} is required for socket routing`);
    return;
  }

  _router = lib.utils.makeSocketRouter(MODULE_ID, {
    any: {
      // Player → GM (aggregated by the lottery-running GM's manager)
      [MSG.PLAYER_ROLL]: (payload, senderId) => {
        if (!game.user.isGM) return;
        gmManager()?.recordResponse(senderId, { roll: payload.roll });
      },
      [MSG.PLAYER_PASS]: (_payload, senderId) => {
        if (!game.user.isGM) return;
        gmManager()?.recordResponse(senderId, { pass: true });
      },
      // GM → players
      [MSG.ITEM_UP_FOR_ROLL]: (payload) => {
        if (game.user.isGM) return;
        playerApp()?.openForItem(payload);
      },
      [MSG.TIE_BREAKER]: (payload) => {
        if (game.user.isGM) return;
        playerApp()?.openForTieBreaker(payload);
      },
      [MSG.ITEM_RESOLVED]: (payload) => {
        if (game.user.isGM) return;
        playerApp()?.closeAndAnnounce(payload);
      },
      [MSG.LOTTERY_COMPLETE]: () => {
        if (game.user.isGM) return;
        playerApp()?.closeAll();
      },
    },
  });
}
