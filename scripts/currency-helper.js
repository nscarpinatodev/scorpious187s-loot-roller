/**
 * CurrencyHelper — thin layer over the shared library's currency engine.
 *
 * The coin math (toCP/fromCP/splitEqually/formatCoins) and the per-system
 * write logic (PF2e/SF2e inventory coins, Fallout caps, generic paths) now
 * live in scorpious187s-lib; this module keeps its exported signatures so
 * callers (and external macros) are unaffected.
 */

export {
  DEFAULT_CONVERSION,
  toCP,
  fromCP,
  splitEqually,
  formatCoins,
} from '/modules/scorpious187s-lib/scripts/systems/currency.js';

const LIB_ID = "scorpious187s-lib";

/**
 * Add coins to an actor's currency (system-agnostic wrapper).
 *
 * @param {Actor}  actor
 * @param {{ cp?:number, sp?:number, ep?:number, gp?:number, pp?:number,
 *           caps?:number, credits?:number, upb?:number }} coins
 */
export async function addCurrencyToActor(actor, coins) {
  if (!actor) return;
  const lib = game.modules.get(LIB_ID)?.api;
  if (!lib) {
    console.error(`LootRoller | ${LIB_ID} is required for currency operations`);
    return;
  }
  await lib.systems.applyCoins(actor, coins);
}
