# Roles and Permissions

Permission codes are plain strings owned by `accounts.permissions.PERMISSIONS` and synced into the
`Permission` table by `accounts.services.sync_permissions()` (idempotent, run by `migrate` and by
`seed_demo`).

## Permission codes

| Group | Codes |
|---|---|
| Products | `products.view` `products.create` `products.update` `products.delete` |
| Inventory | `inventory.view` `inventory.adjust` `inventory.transfer` `inventory.count` |
| Sales | `sales.view` `sales.create` `sales.discount` `sales.discount_override` `sales.cancel` `sales.refund` `sales.refund_override` `sales.payment_record` |
| Orders | `orders.view` `orders.update_status` `orders.fulfil` |
| Purchases | `purchases.view` `purchases.create` `purchases.receive` `purchases.pay` |
| Finance | `finance.view` `finance.manage` `finance.transfer` `finance.adjust` `finance.expense` |
| Customers | `customers.view` `customers.create` `customers.update` |
| Reports | `reports.view` `reports.financial` `reports.export` |
| Users | `users.view` `users.manage` |
| Settings | `settings.view` `settings.manage` |
| Content | `content.review_moderate` `content.coupons_manage` |
| Audit | `audit.view` |

## Default role matrix

`✔` granted · `—` denied

| Code | OWNER | ADMIN | MANAGER | CASHIER | INVENTORY_MANAGER | ACCOUNTANT | CUSTOMER |
|---|---|---|---|---|---|---|---|
| products.view | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| products.create / update | ✔ | ✔ | ✔ | — | ✔ | — | — |
| products.delete | ✔ | ✔ | — | — | — | — | — |
| inventory.view | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| inventory.adjust / transfer / count | ✔ | ✔ | ✔ | — | ✔ | — | — |
| sales.view | ✔ | ✔ | ✔ | ✔ | — | ✔ | — |
| sales.create | ✔ | ✔ | ✔ | ✔ | — | — | — |
| sales.discount | ✔ | ✔ | ✔ | ✔ | — | — | — |
| sales.discount_override | ✔ | ✔ | ✔ | — | — | — | — |
| sales.cancel | ✔ | ✔ | ✔ | — | — | — | — |
| sales.refund | ✔ | ✔ | ✔ | — | — | — | — |
| sales.refund_override | ✔ | ✔ | — | — | — | — | — |
| sales.payment_record | ✔ | ✔ | ✔ | ✔ | — | ✔ | — |
| orders.view | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ | — |
| orders.update_status / fulfil | ✔ | ✔ | ✔ | — | ✔ | — | — |
| purchases.view | ✔ | ✔ | ✔ | — | ✔ | ✔ | — |
| purchases.create | ✔ | ✔ | ✔ | — | ✔ | — | — |
| purchases.receive | ✔ | ✔ | ✔ | — | ✔ | — | — |
| purchases.pay | ✔ | ✔ | — | — | — | ✔ | — |
| finance.view | ✔ | ✔ | ✔ | ✔ | — | ✔ | — |
| finance.manage | ✔ | ✔ | — | — | — | ✔ | — |
| finance.transfer | ✔ | ✔ | ✔ | — | — | ✔ | — |
| finance.adjust | ✔ | ✔ | ✔ | — | — | ✔ | — |
| finance.expense | ✔ | ✔ | ✔ | — | — | ✔ | — |
| customers.view | ✔ | ✔ | ✔ | ✔ | — | ✔ | — |
| customers.create / update | ✔ | ✔ | ✔ | ✔ | — | — | — |
| reports.view | ✔ | ✔ | ✔ | — | ✔ | ✔ | — |
| reports.financial | ✔ | ✔ | ✔ | — | — | ✔ | — |
| reports.export | ✔ | ✔ | ✔ | — | ✔ | ✔ | — |
| users.view | ✔ | ✔ | ✔ | — | — | — | — |
| users.manage | ✔ | ✔ | — | — | — | — | — |
| settings.view | ✔ | ✔ | ✔ | — | — | ✔ | — |
| settings.manage | ✔ | ✔ | — | — | — | — | — |
| content.review_moderate | ✔ | ✔ | ✔ | — | — | — | — |
| content.coupons_manage | ✔ | ✔ | ✔ | — | — | — | — |
| audit.view | ✔ | ✔ | — | — | — | ✔ | — |

`CUSTOMER` holds no staff permission. Customer-facing endpoints authorise on ownership
(`obj.customer.user == request.user`), not on permission codes.

## Enforcement

```python
class ProductViewSet(viewsets.ModelViewSet):
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["products.view"], "retrieve": ["products.view"],
        "create": ["products.create"], "update": ["products.update"],
        "partial_update": ["products.update"], "destroy": ["products.delete"],
    }
```

A single `@action` may serve both a safe and an unsafe method. One list for such an action would
authorise the write with whatever the read needs, so it scopes its requirement **per HTTP method**:

```python
required_permissions = {
    # `customers.view` is read-only. Writing an address needs `customers.update`,
    # which is what stops an ACCOUNTANT — view without update — writing one.
    "addresses": {"GET": ["customers.view"], "POST": ["customers.update"]},
}
```

- `OWNER` short-circuits to allowed.
- A method missing from a per-method mapping is denied, the same way a missing action is.
- Permission codes are resolved once per request and cached on the user object.
- Branch scope: `accounts.scoping.branch_queryset(request, qs)` narrows any branch-bearing queryset to
  the user's branch unless the user is `OWNER`/`ADMIN` or holds an explicit cross-branch grant.
- POS manager elevation: `POST /api/v1/pos/elevate/` verifies a manager's credentials, returns a
  short-lived elevation token scoped to one permission and one register, and writes an audit entry.
  The cashier's own session is never upgraded.
