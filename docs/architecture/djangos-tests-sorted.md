# Django's tests, sorted by what they reach that no parity case does

**Status:** measured 2026-10-13 and 2026-10-14 · step 1.6 of [the removal plan](django-removal-plan.md) ·
the tools are in `scripts/tests-against-parity/`

The plan's step 1.6 asks that Django's own tests be sorted into three before Django goes:
those a parity case already covers; an invariant no case reaches, to be ported; and
Django-only, which goes with the thing it tests. [recorded-proof.md](recorded-proof.md) had
them sorted by file. This sorts them by test, from a measurement.

## The method

Two runs of the same code, both with branch coverage:

1. **Django's suite**, with one coverage context per test and phase
   (`pytest --cov --cov-branch --cov-context=test`): for every statement and branch, which
   tests ran it, and whether while the test ran or while a fixture set it up.
2. **A whole parity comparison**, races included, with Django serving it under coverage: one
   worker, so one file, stopped gracefully so that it is written.

Subtracting the second from the first leaves the rule code that only the tests reach, with
the tests that reach it. Each function holding such code was then read and given one of
seven kinds (`classes.py`), and a test takes the kind of what it alone reaches.

```bash
scripts/tests-against-parity/run.sh tests     # about 13 minutes
scripts/tests-against-parity/run.sh parity    # about 25; resets the parity stack's database
scripts/tests-against-parity/run.sh diff      # the tables below, and djangos-tests-sorted.tsv
```

"Rule code" is everything under `apps/api` but the tests, the migrations, `config/`, the
management commands and the Django admin. The commands are counted apart: 25 functions of
theirs are reached by the tests alone, all of them the seed and the two `verify_*` commands,
which go with plan steps 2 and 4.

## What it found

**The comparison reaches more of Django's rule code than Django's own tests do**: 10,476
statements of 10,957 against 10,234. What only the tests reach was 174 statements and 73
branches, in 84 functions. Each function was read, and most of it is not a rule the port could
be missing:

- **Second doors.** A service refuses what its serializer has already refused, or a model
  fills in what every caller already passes. The test calls the service directly; no request
  gets that far.
- **Settings.** The parity stack runs with one value of each. Two of these explain most of
  the tests that reach anything alone: 329 tests run with no revalidation address set, and so
  take the early return the parity stack never takes.
- **No caller, and no such row.** Helpers only the tests, the seed or a command call; and
  states only the tests' factories make, such as an order with no lines.

What was left is the list this was for: **28 functions a request can reach and no case did.**
Twenty-five have cases now -- 40 new cases over two days -- and **both APIs agreed on every
one**: branches of the port that nothing had compared before. The other three need a shop
with nothing in it yet, which the parity database is not.

The first reading put 36 functions on that list. Eight came off it when each was followed to
its caller: the importer and the serializers always pass a slug, so the models' own fallback
is a second door; a supplier is promoted from an offer the view has just read; every SMS
template is fixed text in one segment; a blank link is never handed to the validator; and two
are states no request produces.

Things the reading turned up that the numbers do not show:

- **Two cases that did not do what their names said.** "delete value with variants" deleted
  Size XS, which no variant in the seed carries, so the refusal in words was never compared.
  "product specs unchanged" sent an empty set to a product that had specifications, which is
  a change. Each has a second case beside it now that does what the name says.
- **The readiness probe was never asked.** Only `OPTIONS /api/ready/` was; `GET` is a case now.
- **Nobody signed in as the seed's own customer.** That account belongs to no organisation and
  owns the one order a customer can read whose payment was captured later: two branches, one
  account, four cases.
- **The rate limits are outside this measurement.** Their 17 scenarios run on a stack of their
  own, which was not under coverage, so `TrustedIdentMixin.get_ident` shows as unreached.

## What it cannot say

Coverage is a coarse sieve. A test sorted `covered` runs no statement or branch that a case
does not also run; that is not the same as a case asserting what the test asserts. The same
line with another number in it is the same line. So:

- **Arithmetic** -- pricing, VAT, costing, coupons, the reports -- is held by the values the
  comparison compares, and by the port's unit tests, which hold values Django printed. This
  measurement adds nothing there.
- **A `covered` test of a refusal** is covered if some case is refused on the same line; the
  comparison then compares the status, the code and the message of that refusal.
- **Second doors were read, not all of them proved.** The finance, inventory, VAT,
  counter-discount, slug and supplier ones were checked against the caller in front of each.
  The rest are sorted by the test's own name ("the service refuses it too", "the lower-level
  door is shut too").
- **Two runs differ a little.** Where requests overlap, a race reaches a line in one run and
  not in the next: `_check_can_reserve`'s refusal came and went between measurements.

## The numbers

<!-- GENERATED by scripts/tests-against-parity/sort_tests.py. Edit classes.py, not this. -->

| | Before | With the cases added |
|---|---|---|
| Statements of rule code | 10,957 | 10,957 |
| reached by Django's tests | 10,234 | 10,234 |
| reached by the comparison | 10,476 | 10,523 |
| reached by both | 10,060 | 10,105 |
| **statements only the tests reach** | 174 | 129 |
| **branches only the tests take** | 73 | 47 |
| functions holding such code | 84 | 60 |

### The tests

| Sort | Tests | What it means |
|---|---|---|
| `covered` | 1,232 | Every statement and branch it runs is one a parity case runs too |
| `to-port` | 0 | A request can reach it; no case does yet |
| `empty-shop` | 33 | Only a shop with nothing in it yet gets there: the parity database is a seeded one |
| `case-added` | 80 | A request reaches it, and a case does now |
| `second-door` | 22 | A service's own check behind a serializer that refuses first: no request reaches it |
| `race` | 1 | Reached only when two requests really overlap: a race check stands for it |
| `setting` | 275 | A setting the comparison runs with one value of |
| `no-such-row` | 4 | Only on rows no request can make; the tests' factories make them |
| `no-caller` | 104 | Nothing in the API calls it; its tests, the seed or a command do |
| `django-only` | 61 | A file that tests Django's own machinery, or a test reaching only that |
| | **1,812** | |

### The functions

**A request can reach it; no case does yet** (0)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|

**Only a shop with nothing in it yet gets there: the parity database is a seeded one** (3)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `accounts/api/serializers.py::MeSerializer.get_organization` | 3, 2 | 17 | `me` with no organisation at all (a customer in none has a case now) |
| `accounts/services.py::update_tax_settings` | 2, 3 | 5 | the VAT changed before any order was priced (the two refusals are second doors) |
| `catalog/importers.py::_attribute_value` | 1, 1 | 11 | an import into a shop with no Size or Colour attribute yet |

**A request reaches it, and a case does now** (25)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `accounts/services.py::tax_settings` | 1, 1 | 14 | the same |
| `catalog/api/serializers.py::AttributeSerializer.validate_is_variant_defining` | 1, 1 | 1 | an unused attribute stops defining variants |
| `catalog/api/serializers.py::AttributeSerializer.validate_kind` | 0, 1 | 1 | a Size attribute with no chart becomes text (a fixture attribute) |
| `catalog/api/serializers.py::GenerateVariantsSerializer.validate` | 1, 1 | 1 | a single version with sizes chosen |
| `catalog/api/views.py::AttributeValueViewSet.perform_destroy` | 1, 1 | 2 | the old case deleted a value no variant carries |
| `catalog/feeds.py::_clip` | 3, 1 | 1 | the feed with a title past the limit |
| `catalog/feeds.py::_looks_like_gtin` | 1, 1 | 2 | the feed with a barcode whose check digit is wrong |
| `catalog/importers.py::_run` | 0, 1 | 2 | an old product with nothing new in the file |
| `catalog/importers.py::_variant` | 1, 1 | 2 | a cost for a SKU the shop already has |
| `catalog/models.py::ProductImage.clean` | 1, 1 | 1 | an image under a colour that defines no variants (a fixture attribute) |
| `catalog/services.py::set_product_specs` | 3, 3 | 3 | no specifications stated and none sent: no audit entry (the two refusals are second doors) -- 3 statements and 2 branches of it are still the tests' alone |
| `content/api/serializers.py::contact_fallbacks` | 1, 1 | 10 | the storefront with the organisation switched off |
| `content/api/serializers.py::serialise_banner` | 1, 1 | 24 | the home page with no banner live |
| `content/selectors.py::_expand` | 1, 1 | 12 | a menu in which no category has a child |
| `content/selectors.py::_footer_links` | 1, 1 | 1 | the footer with every page unpublished |
| `content/validators.py::map_link_for_address` | 1, 1 | 15 | the site with no address anywhere |
| `content/validators.py::whatsapp_number` | 2, 1 | 1 | the storefront read with the WhatsApp link in its long form |
| `core/slugs.py::_spell` | 3, 1 | 6 | Bengali names with a vowel alone, a sign, digits |
| `core/slugs.py::_units` | 8, 2 | 7 | the same, and a nasal before a velar |
| `core/views.py::ready_view` | 11, 0 | 1 | GET /api/ready/ was never asked, only OPTIONS |
| `inventory/services.py::apply_stock_count` | 0, 1 | 2 | a count applied with a line that changes nothing |
| `orders/api/serializers.py::customer_event_text` | 1, 1 | 4 | the seed's customer reading an order whose payment was captured |
| `orders/services/checkout.py::_merge_guest_cart` | 1, 1 | 1 | signing in with a token that is no cart |
| `orders/services/payments.py::_replayed` | 1, 1 | 1 | an Idempotency-Key another order's payment holds |
| `orders/services/shortages.py::flag_short_orders` | 1, 1 | 1 | one more unit sold from a shelf already one short |

**A service's own check behind a serializer that refuses first: no request reaches it** (19)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `catalog/models.py::Brand.save` | 1, 1 | 5 | a brand saved with no slug: the serializer and the importer both pass one |
| `catalog/models.py::Category.save` | 1, 1 | 5 | the same |
| `catalog/models.py::Product.save` | 1, 1 | 6 | the same |
| `catalog/services.py::set_product_size_chart` | 1, 1 | 1 | `test_the_service_refuses_it_too` |
| `core/phone.py::normalize` | 1, 1 | 3 | the model's last resort, behind every form's own check |
| `finance/services.py::check_named_account` | 1, 1 | 1 | every endpoint validates the method first, the counter's since D158 |
| `finance/services.py::create_expense_category` | 1, 1 | 1 | the serializer requires a name |
| `finance/services.py::record_expense` | 1, 1 | 2 | `CreateExpenseSerializer.validate_amount` |
| `finance/services.py::transfer` | 1, 1 | 1 | `CreateTransferSerializer.validate` |
| `finance/services.py::update_account` | 1, 1 | 1 | `balance` is not a field the serializer writes |
| `finance/services.py::void_expense` | 1, 1 | 1 | `VoidExpenseSerializer.validate_reason` |
| `inventory/services.py::adjust` | 1, 1 | 1 | the serializer requires a reason |
| `inventory/services.py::apply_transaction` | 4, 3 | 2 | an ADJUSTMENT through the lower-level door, which no view opens; and one line only a real race reaches |
| `inventory/services.py::return_to_supplier` | 1, 1 | 1 | the serializer's minimum of 1 |
| `inventory/services.py::write_off` | 1, 1 | 1 | the serializer's choice of DAMAGE or LOSS |
| `orders/services/pos.py::_manual_discount` | 1, 1 | 1 | the serializer refuses an amount and a percentage together |
| `orders/services/pricing.py::price_lines` | 1, 1 | 1 | every serializer's minimum quantity of 1 |
| `purchasing/services.py::create_purchase_return` | 1, 1 | 1 | the serializer requires a reason |
| `purchasing/services.py::set_preferred_supplier` | 2, 0 | 1 | the view promotes an offer it has just read, so the offer is there |

**Reached only when two requests really overlap: a race check stands for it** (1)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `purchasing/services.py::record_supplier_payment` | 1, 1 | 1 | the key found under the lock: `supplier payments: 6 clicks of one payment` |

**A setting the comparison runs with one value of** (10)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `catalog/feeds.py::public_url` | 1, 1 | 2 | PUBLIC_URL unset |
| `content/tasks.py::request_revalidation` | 1, 1 | 329 | WEB_REVALIDATE_URL unset: the parity stack sets it, the tests do not |
| `core/ip.py::client_ip` | 5, 1 | 11 | TRUSTED_PROXY_HOPS above 0: the parity stack has no proxy |
| `core/throttling.py::TrustedIdentMixin.get_ident` | 1, 0 | 7 | throttling by address: the 17 rate-limit scenarios, which run on a stack this measurement did not cover |
| `inventory/services.py::check_availability` | 1, 1 | 1 | RANGON_ALLOW_OVERSELL on |
| `notifications/registry.py::available_providers` | 1, 0 | 1 | read only for that error's message |
| `notifications/registry.py::get_provider` | 1, 1 | 1 | a provider code nobody registered |
| `notifications/registry.py::register` | 1, 0 | 6 | a test's stand-in provider |
| `notifications/sms.py::_may_send_to` | 1, 1 | 8 | SMS_LIVE on |
| `notifications/sms.py::send_sms` | 6, 0 | 1 | a provider selected and not configured |

**Only on rows no request can make; the tests' factories make them** (2)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `inventory/services.py::_bulk` | 1, 1 | 3 | an order with no lines cancelled: the tests' factory makes one, checkout cannot |
| `inventory/services.py::consume_reservation` | 1, 1 | 1 | an order packed whose lines were all sold already, and not marked so |

**Nothing in the API calls it; its tests, the seed or a command do** (17)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `content/validators.py::map_embed_for_address` | 3, 0 | 1 |  |
| `content/validators.py::validate_link_url` | 1, 1 | 1 | a blank value: its one caller asks only when there is a link |
| `core/money.py::percentage_of` | 1, 0 | 1 |  |
| `core/money.py::to_decimal` | 6, 1 | 8 | every API caller passes a Decimal |
| `core/ordering.py::unique_last` | 3, 3 | 1 | what is not a queryset of model rows: no view hands it one |
| `core/phone.py::normalize_if_mobile` | 1, 1 | 1 | None in: no form sends it |
| `customers/models.py::CustomerAddress.as_snapshot` | 1, 0 | 4 | the seed |
| `finance/services.py::balance_at` | 2, 0 | 1 |  |
| `inventory/services.py::get_or_create_inventory` | 2, 0 | 163 | the tests' factory and the seed |
| `notifications/sms.py::segments` | 4, 3 | 6 | every template is fixed ASCII in one segment; only its tests hand it another body |
| `orders/models.py::Order.cogs_total` | 1, 0 | 4 | the same |
| `orders/models.py::Order.gross_profit` | 1, 0 | 4 | the same |
| `orders/models.py::Order.net_revenue` | 4, 0 | 4 | the same |
| `orders/services/checkout.py::price_cart` | 2, 1 | 1 | an exception that is not a refusal while a coupon is re-read: a fault, injected by its test |
| `orders/services/pricing.py::PricedOrder.net_revenue` | 4, 0 | 3 | the reports compute it in SQL |
| `orders/services/pricing.py::change_due` | 2, 0 | 1 |  |
| `purchasing/services.py::supplier_cost_for` | 1, 0 | 3 |  |

**Django's own machinery: nothing to port, or it goes with a later step** (7)

| Function | Statements, branches | Tests | Note |
|---|---|---|---|
| `accounts/apps.py::sync_permissions_after_migrate` | 9, 0 | 5 | `migrate` keeping the roles in step: plan step 3 |
| `accounts/services.py::sync_permissions` | 12, 0 | 7 | the same: becomes the test of `sync-permissions` |
| `core/models.py::AppendOnlyModel.delete` | 1, 0 | 3 | the same |
| `core/models.py::AppendOnlyModel.save` | 1, 1 | 3 | a guard on the ORM's `save`: the port writes no ledger row through a model |
| `finance/services.py::repair_drift` | 7, 0 | 2 | `verify_accounts --repair`: an operator command, plan step 4 |
| `inventory/services.py::IntegrityIssue.on_hand_drift` | 1, 0 | 1 | read by that command only |
| `inventory/services.py::repair_drift` | 7, 0 | 1 | `verify_inventory --repair`: the same |

### By file

| File | Tests | covered | to-port | empty-shop | case-added | second-door | race | setting | no-such-row | no-caller | django-only |
|---|---|---|---|---|---|---|---|---|---|---|---|
| `tests/api/test_attribute_admin.py` | 21 | 19 |  |  | 2 |  |  |  |  |  |  |
| `tests/api/test_barcode_assignment.py` | 10 | 10 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_branch_scope.py` | 25 | 24 |  | 1 |  |  |  |  |  |  |  |
| `tests/api/test_client_ip_and_throttling.py` | 16 | 3 |  |  |  |  |  | 13 |  |  |  |
| `tests/api/test_coupons_admin.py` | 21 | 21 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_customer_order_payload.py` | 7 | 3 |  |  | 4 |  |  |  |  |  |  |
| `tests/api/test_customers_admin.py` | 23 | 23 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_drafts_never_ordered.py` | 1 | 0 |  |  |  |  |  | 1 |  |  |  |
| `tests/api/test_error_leakage.py` | 4 | 3 |  |  |  |  |  |  |  | 1 |  |
| `tests/api/test_expenses_admin.py` | 24 | 24 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_finance_admin.py` | 32 | 32 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_generate_variants_guards.py` | 3 | 0 |  |  |  |  |  | 3 |  |  |  |
| `tests/api/test_home_carousel.py` | 20 | 2 |  |  | 5 |  |  | 12 |  | 1 |  |
| `tests/api/test_idempotency.py` | 7 | 7 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_inventory_adjust.py` | 17 | 13 |  |  |  |  |  | 2 |  | 2 |  |
| `tests/api/test_label_sheet.py` | 26 | 15 |  |  |  |  |  | 3 |  | 6 | 2 |
| `tests/api/test_ledger_and_audit_readers.py` | 20 | 9 |  |  |  |  |  | 11 |  |  |  |
| `tests/api/test_logout.py` | 9 | 9 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_merchandising.py` | 14 | 2 |  |  | 1 |  |  | 10 |  | 1 |  |
| `tests/api/test_named_accounts.py` | 13 | 12 |  |  |  | 1 |  |  |  |  |  |
| `tests/api/test_navigation.py` | 26 | 6 |  |  | 15 |  |  | 5 |  |  |  |
| `tests/api/test_non_latin_slugs.py` | 9 | 0 |  |  | 2 | 2 |  | 5 |  |  |  |
| `tests/api/test_order_list_filters.py` | 6 | 6 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_password_self_service.py` | 14 | 0 |  | 14 |  |  |  |  |  |  |  |
| `tests/api/test_payment_webhooks.py` | 5 | 5 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_phone_identity.py` | 27 | 26 |  |  |  | 1 |  |  |  |  |  |
| `tests/api/test_pos_api.py` | 12 | 12 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_pos_customer_lookup.py` | 19 | 19 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_pos_quote.py` | 17 | 17 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_private_receipts.py` | 12 | 11 |  |  |  |  |  | 1 |  |  |  |
| `tests/api/test_product_admin.py` | 12 | 0 |  |  |  |  |  | 12 |  |  |  |
| `tests/api/test_product_admin_search.py` | 8 | 0 |  |  |  |  |  | 8 |  |  |  |
| `tests/api/test_product_feed.py` | 40 | 25 |  |  | 3 |  |  | 12 |  |  |  |
| `tests/api/test_product_import.py` | 26 | 15 |  | 11 |  |  |  |  |  |  |  |
| `tests/api/test_product_media.py` | 19 | 1 |  |  | 1 |  |  | 17 |  |  |  |
| `tests/api/test_product_specs.py` | 24 | 19 |  |  | 3 |  |  | 2 |  |  |  |
| `tests/api/test_purchase_order_guards.py` | 8 | 0 |  |  |  |  |  | 8 |  |  |  |
| `tests/api/test_purchase_order_list_filters.py` | 4 | 4 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_purchasing_admin.py` | 46 | 10 |  |  |  |  |  | 36 |  |  |  |
| `tests/api/test_returns_admin.py` | 22 | 22 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_reviews_admin.py` | 12 | 12 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_role_catalogue.py` | 10 | 10 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_search_suggest.py` | 11 | 2 |  |  | 6 |  |  | 3 |  |  |  |
| `tests/api/test_shipment_fulfilment.py` | 30 | 30 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_shipping_admin.py` | 19 | 19 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_shop.py` | 31 | 26 |  |  | 1 |  |  | 4 |  |  |  |
| `tests/api/test_single_version_products.py` | 8 | 0 |  |  | 1 |  |  | 7 |  |  |  |
| `tests/api/test_site_content.py` | 53 | 35 |  |  | 15 |  |  | 3 |  |  |  |
| `tests/api/test_size_charts.py` | 43 | 35 |  |  | 1 | 1 |  | 6 |  |  |  |
| `tests/api/test_staff_profiles.py` | 14 | 14 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_stock_documents.py` | 20 | 19 |  |  |  |  |  | 1 |  |  |  |
| `tests/api/test_stock_needs_a_receipt.py` | 14 | 1 |  |  | 2 | 1 |  | 9 |  | 1 |  |
| `tests/api/test_taxonomy_admin.py` | 20 | 8 |  |  | 1 |  |  | 11 |  |  |  |
| `tests/api/test_upload_limits.py` | 20 | 17 |  |  |  |  |  | 3 |  |  |  |
| `tests/api/test_users_admin.py` | 13 | 13 |  |  |  |  |  |  |  |  |  |
| `tests/api/test_variant_label_fields.py` | 5 | 2 |  |  |  |  |  | 3 |  |  |  |
| `tests/test_abandoned_checkout.py` | 27 | 27 |  |  |  |  |  |  |  |  |  |
| `tests/test_business_summary.py` | 18 | 2 |  |  |  |  |  |  |  | 16 |  |
| `tests/test_concurrency.py` | 28 | 14 |  |  | 1 | 1 | 1 | 11 |  |  |  |
| `tests/test_counter_reserved_stock.py` | 13 | 11 |  |  | 1 |  |  | 1 |  |  |  |
| `tests/test_expenses.py` | 32 | 28 |  |  |  | 4 |  |  |  |  |  |
| `tests/test_finance.py` | 28 | 22 |  |  |  | 2 |  |  |  | 1 | 3 |
| `tests/test_guards_before_django_goes.py` | 46 | 42 |  |  | 1 |  |  |  | 3 |  |  |
| `tests/test_inventory.py` | 28 | 11 |  |  |  | 3 |  | 11 | 1 |  | 2 |
| `tests/test_label_print_migration.py` | 4 | 0 |  |  |  |  |  |  |  |  | 4 |
| `tests/test_net_profit.py` | 18 | 14 |  |  |  |  |  |  |  | 4 |  |
| `tests/test_one_order.py` | 34 | 21 |  |  |  |  |  | 5 |  | 8 |  |
| `tests/test_orders.py` | 32 | 27 |  |  |  |  |  | 5 |  |  |  |
| `tests/test_party_ledger.py` | 32 | 32 |  |  |  |  |  |  |  |  |  |
| `tests/test_performance.py` | 25 | 0 |  |  |  |  |  |  |  |  | 25 |
| `tests/test_permission_sync.py` | 5 | 0 |  |  |  |  |  |  |  |  | 5 |
| `tests/test_permissions.py` | 39 | 36 |  | 2 | 1 |  |  |  |  |  |  |
| `tests/test_pos_discounts.py` | 36 | 34 |  |  |  | 1 |  | 1 |  |  |  |
| `tests/test_purchasing.py` | 44 | 39 |  |  |  | 2 |  |  |  | 3 |  |
| `tests/test_report_discounts.py` | 12 | 0 |  |  |  |  |  |  |  | 12 |  |
| `tests/test_report_ranges.py` | 22 | 22 |  |  |  |  |  |  |  |  |  |
| `tests/test_return_refund_discounts.py` | 11 | 0 |  |  |  |  |  |  |  | 11 |  |
| `tests/test_seed_demo_guard.py` | 15 | 0 |  |  |  |  |  |  |  |  | 15 |
| `tests/test_seed_reset.py` | 3 | 0 |  |  |  |  |  |  |  |  | 3 |
| `tests/test_sms.py` | 41 | 23 |  |  |  |  |  | 13 |  | 5 |  |
| `tests/test_tax.py` | 33 | 20 |  | 5 |  |  |  | 4 |  | 4 |  |
| `tests/test_vat_report.py` | 24 | 8 |  |  |  |  |  |  |  | 16 |  |
| `tests/test_walk_in_customer.py` | 5 | 5 |  |  |  |  |  |  |  |  |  |
| `tests/unit/test_email_timeout.py` | 1 | 0 |  |  |  |  |  |  |  |  | 1 |
| `tests/unit/test_phone.py` | 51 | 48 |  |  |  | 2 |  |  |  | 1 |  |
| `tests/unit/test_pricing.py` | 31 | 1 |  |  | 7 | 1 |  | 13 |  | 9 |  |
| `tests/unit/test_psycopg_adapters.py` | 1 | 0 |  |  |  |  |  |  |  |  | 1 |
| `tests/unit/test_site_content_rules.py` | 62 | 59 |  |  | 1 |  |  |  |  | 2 |  |
| `tests/unit/test_slugs.py` | 19 | 14 |  |  | 5 |  |  |  |  |  |  |

## What is left to port

Three functions, sorted `empty-shop`: each is reached only in a shop with nothing in it yet.

| Function | What gets there |
|---|---|
| `MeSerializer.get_organization` | `me` when there is no organisation at all |
| `update_tax_settings` | the VAT changed before any order was priced: no warning to confirm |
| `importers._attribute_value` | the first import, which makes the Size and Colour attributes |

All three are things a new installation does on its first day, and the port has code for
each. The parity database is a seeded shop, and no case can empty it: orders and variants
protect what they refer to. They want a second flavour of the parity stack -- migrated, with
its roles and one owner, and nothing else -- and a short list of cases run against it. That is
a piece of work of its own, and it is the last of step 1.6.

Until then those three branches of the port are compared with nothing.

The per-test list is [djangos-tests-sorted.tsv](djangos-tests-sorted.tsv).
