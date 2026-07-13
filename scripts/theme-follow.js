/**
 * Theme following — Loot Roller has no theme of its own; its windows follow
 * the family-wide theme owned by the shared library (scorpious187s-lib).
 *
 * The old sibling-provider hierarchy (Quest Tracker, then Customizable Shop)
 * is gone: the library is the single authority. Loot Roller registers itself
 * as a theming consumer; the library stamps `data-sqt-theme` on our windows
 * (which this module's stylesheet reads) and keeps the `--sqt-*` variables
 * mirrored on :root, whether or not Quest Tracker is installed.
 */

const MODULE_ID = "scorpious187s-loot-roller";
const LIB_ID = "scorpious187s-lib";

/** Register with the library's theming registry. Call once from init. */
export function registerThemeFollowing() {
  const lib = game.modules.get(LIB_ID)?.api;
  lib?.theming.register({
    moduleId: MODULE_ID,
    prefix: "--sqt-",
    windowClass: "loot-roller",
    datasetKey: "sqtTheme",
    // Backgrounds come from this module's own [data-sqt-theme] CSS rules;
    // no inline background forcing (matches the old provider behavior).
    inlineTargets: [],
  });
}

/**
 * Apply the family theme to a Loot Roller window element.
 * @param {HTMLElement} el The application's root element.
 */
export function applyFollowedTheme(el) {
  if (!el) return;
  try {
    game.modules.get(LIB_ID)?.api?.theming.ThemeManager.applyToElement(el, MODULE_ID);
  } catch (err) {
    console.warn("LootRoller | theme follow failed:", err);
  }
}

/** Re-apply the followed theme to every currently-open Loot Roller window. */
export function refreshOpenWindows() {
  document.querySelectorAll(".application.loot-roller").forEach((el) => applyFollowedTheme(el));
}
