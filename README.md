# Loot Roller

A system-agnostic loot generator for [Foundry VTT](https://foundryvtt.com/) with a
real-time player **lottery / roll-off** for distributing items. Generate treasure
hoards, build quest rewards, and stock shops — then let your players roll for who
gets what. Items are pulled from your installed system compendiums.

## Supported systems

Adapters ship out of the box for:

| System | Generation model | Currency |
|---|---|---|
| **D&D 5e** (`dnd5e`) | Treasure type + CR range, rarity filters | gp / sp / cp |
| **Pathfinder 2e** (`pf2e`) | Treasure-by-Level budget, item-level filters | Coins (gp/sp/cp) |
| **Starfinder 2e** (`sf2e`) | Treasure-by-Level budget, item-level filters | Credits + UPBs |
| **Fallout 2d20** (`fallout`) | Location + threat tables, item-type filters | Caps |

Other systems can register their own adapter at runtime via the plugin API
(`LootRoller.registerSystem(MyAdapter)`).

## Installation

In Foundry VTT: **Add-on Modules → Install Module**, then paste the manifest URL:

```
https://github.com/nscarpinatodev/loot-roller/releases/latest/download/module.json
```

Enable **Loot Roller** in your world's module settings.

## Usage

A coin button is added to the GM scene controls. Click it to open the **Loot Hub**,
which launches the three generators:

- **Treasure Hoard** — roll budget-based loot for the party. Roll repeatedly to
  accumulate a haul, remove unwanted entries, then send it to the lottery.
- **Quest Reward Builder** — roll items one at a time and curate a reward list.
- **Shop Generator** — bulk-generate a shop inventory and create a loot/merchant
  actor stocked with the results.

From any generator you can hand the items off to the **lottery**: players roll a
d20 for each item (with pass/tiebreaker handling), and winners receive the item.
Currency is split among the party or sent to a configured party stash.

### Compendium sources

Use **Game Settings → Configure Settings → Loot Roller → Compendium Sources** to
choose which Item compendiums each generator draws from. Defaults are resolved
per system; Starfinder 2e and Fallout auto-detect their system's Item packs.

## Compatibility

Foundry VTT v12–v14.

## License

[MIT](LICENSE)
