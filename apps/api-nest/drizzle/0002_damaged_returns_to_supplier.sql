-- A damaged customer return goes back to the supplier on a purchase return
-- (business rules 2.3). The purchase-return line names the customer-return
-- line it credits, so one damaged item is credited once.
--
-- Additive only: a nullable column with no default (no table rewrite, every
-- existing row reads NULL), a foreign key, and a unique constraint that NULLs
-- do not take part in. The release before this one ignores the column.
-- Serves: the list of damaged items still to go back ("no purchase-return line
-- names it") and the refusal of a second credit for the same item.
ALTER TABLE "purchasing_purchasereturnitem" ADD COLUMN "return_item_id" uuid;--> statement-breakpoint
ALTER TABLE "purchasing_purchasereturnitem" ADD CONSTRAINT "purchasing_purchasereturnitem_return_item_id_fk" FOREIGN KEY ("return_item_id") REFERENCES "public"."orders_returnitem"("id") ON DELETE no action ON UPDATE no action DEFERRABLE INITIALLY DEFERRED;--> statement-breakpoint
ALTER TABLE "purchasing_purchasereturnitem" ADD CONSTRAINT "purchasing_purchasereturnitem_return_item_id_uniq" UNIQUE("return_item_id");
