# ADR-0006 — Weighted average cost, frozen onto the order line

**Status:** Accepted · 2026-08-17

## Context

Plan §28 recommends weighted average cost and forbids computing profit as "selling price − current
product cost". Alternatives: FIFO/lot layers, specific identification, standard cost.

## Decision

- `Inventory.average_cost` per branch × variant, recalculated **only** when stock is received:
  `((on_hand × average_cost) + (qty × unit_cost)) / (on_hand + qty)`.
- At sale time the current `average_cost` is copied to `OrderItem.unit_cost`.
- Reports compute COGS from the frozen `OrderItem.unit_cost`, never from today's cost.

## Consequences

- Historical gross profit is stable: changing a price or receiving cheaper stock tomorrow does not
  rewrite yesterday's margin.
- Deterministic and explainable to an accountant in one sentence, which FIFO layers are not.
- Cost is per branch, so a transfer moves stock at the source branch's average cost (`TRANSFER_IN`
  carries `unit_cost`), keeping each branch's margin honest.
- FIFO/lot costing (relevant if cosmetics batches are ever purchased at very different prices) would
  require lot layers and a new COGS resolution step. That is a V2 schema change, deliberately deferred.
- Returns credit COGS back at the same frozen cost.
