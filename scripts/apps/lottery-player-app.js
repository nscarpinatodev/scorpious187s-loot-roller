/**
 * LotteryPlayerApp — Player-facing popup for rolling on a lottery item.
 *
 * Opens when the GM broadcasts a lottery item. Shows the item card and
 * two buttons: Roll (d20) and Pass. Includes a countdown timer if the
 * GM has set a timeout. Auto-closes when the item is resolved.
 *
 * Static helpers handle incoming socket messages without requiring a
 * pre-existing instance.
 */

import { emit, MSG } from "../socket.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

let _instance = null;
let _timerInterval = null;
let _secondsLeft = 0;

export class LotteryPlayerApp extends HandlebarsApplicationMixin(ApplicationV2) {
  static DEFAULT_OPTIONS = {
    id: "lottery-player-app",
    classes: ["loot-roller", "lottery-player"],
    window: { title: "LOOTROLLER.lottery.rollTitle", icon: "fa-solid fa-dice-d20", minimizable: false },
    position: { width: 360, height: "auto" },
  };

  static PARTS = {
    content: { template: "modules/loot-roller/templates/lottery-player.hbs" },
  };

  constructor(itemPayload, tieBreakerMode = false, options = {}) {
    super(options);
    this._item = itemPayload;
    this._tieBreakerMode = tieBreakerMode;
    this._rolled = false;
    this._rollResult = null;
    this._showDescription = false;
  }

  async _prepareContext(options) {
    const timeout = game.settings.get("loot-roller", "lotteryTimeout");
    return {
      item:            this._item,
      tieBreakerMode:  this._tieBreakerMode,
      rolled:          this._rolled,
      rollResult:      this._rollResult,
      hasTimer:        timeout > 0,
      secondsLeft:     _secondsLeft,
      round:           this._item.round,
      total:           this._item.total,
      hasDescription:  !!(this._item.itemDescription?.trim()),
      showDescription: this._showDescription,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);

    this.element.querySelector("[data-action=toggle-description]")
      ?.addEventListener("click", () => {
        this._showDescription = !this._showDescription;
        this.render(false);
      });

    const rollBtn = this.element.querySelector("[data-action=roll]");
    const passBtn = this.element.querySelector("[data-action=pass]");

    if (rollBtn) {
      rollBtn.addEventListener("click", async () => {
        if (this._rolled) return;
        this._rolled = true;
        this._rollResult = Math.floor(Math.random() * 20) + 1;

        // Create a Foundry Roll for the chat message / dice so sound/animation work
        const roll = new Roll("1d20");
        await roll.evaluate();
        this._rollResult = roll.total;
        await roll.toMessage({ flavor: game.i18n.format("LOOTROLLER.chat.playerRolledFor", { item: this._item.itemName }) });

        emit(MSG.PLAYER_ROLL, { roll: this._rollResult });
        this.render(false);
      });
    }

    if (passBtn) {
      passBtn.addEventListener("click", () => {
        if (this._rolled) return;
        this._rolled = true;
        emit(MSG.PLAYER_PASS, {});
        this.render(false);
      });
    }
  }

  close(options = {}) {
    _clearTimer();
    _instance = null;
    return super.close(options);
  }

  // ── Static socket-driven helpers ─────────────────────────────────────────

  /** GM broadcast: open this popup for a new item. */
  static openForItem(payload) {
    if (_instance) _instance.close({ force: true });
    _instance = new LotteryPlayerApp(payload, false);
    _instance.render(true);
    _startTimer();
  }

  /** GM broadcast: tie-breaker — only opens for players in the tie. */
  static openForTieBreaker(payload) {
    if (!payload.tiedPlayerIds.includes(game.user.id)) return;
    if (_instance) _instance.close({ force: true });
    _instance = new LotteryPlayerApp(payload, true);
    _instance.render(true);
    _startTimer();
  }

  /** GM broadcast: item awarded — close popup and show who won. */
  static closeAndAnnounce(payload) {
    if (_instance) _instance.close({ force: true });
    // Brief notification to non-winners
    if (payload.winnerId && payload.winnerId !== game.user.id) {
      ui.notifications.info(
        game.i18n.format("LOOTROLLER.notify.playerWon", { player: payload.winnerName, item: payload.itemName })
      );
    } else if (payload.winnerId === game.user.id) {
      ui.notifications.info(
        game.i18n.format("LOOTROLLER.notify.youWon", { item: payload.itemName })
      );
    }
  }

  /** GM broadcast: lottery finished — ensure all popups are closed. */
  static closeAll() {
    if (_instance) _instance.close({ force: true });
  }
}

function _startTimer() {
  _clearTimer();
  const timeout = game.settings.get("loot-roller", "lotteryTimeout");
  if (timeout <= 0 || !_instance) return;

  _secondsLeft = timeout;
  _instance.render(false);

  _timerInterval = setInterval(() => {
    _secondsLeft = Math.max(0, _secondsLeft - 1);
    _instance?.render(false);
    if (_secondsLeft <= 0) _clearTimer();
  }, 1000);
}

function _clearTimer() {
  if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
}
