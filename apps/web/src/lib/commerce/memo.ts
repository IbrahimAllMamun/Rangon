/**
 * What a customer memo may say about VAT.
 *
 * A memo — the POS receipt or the A4 invoice — carries a VAT block: the shop's
 * registration number in the header and the tax line above the total. Both
 * belong to the same fact, so both appear together or neither does.
 *
 * The amount lines were already conditional. The registration number was not,
 * so a shop running at 0% printed `VAT: <BIN>` on every memo while charging no
 * VAT — a memo that announces a VAT registration and then shows no tax reads
 * like tax was collected and withheld. `default_tax_rate` ships at `0.0000`
 * (business-rules.md §3.4), so that was every memo the platform had ever
 * printed.
 *
 * The test is the **order's own** tax, not today's organisation setting, so
 * reprinting a year-old memo shows what that sale actually charged. An order
 * priced before VAT was switched on keeps a bare memo forever, which is the
 * truth about it.
 *
 * Note for a VAT-registered shop selling zero-rated or exempt goods: those
 * memos will not carry the BIN either, because this looks at what was charged
 * rather than at whether the shop is registered. Say so if that shop exists —
 * the rule then moves to the organisation's registration, not the order's tax.
 */
export function memoShowsVat(order: { tax_total: string | number | null | undefined }): boolean {
  return Number(order.tax_total ?? 0) > 0;
}
