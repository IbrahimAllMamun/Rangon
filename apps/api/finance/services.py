"""Finance engine -- the only code allowed to move money between accounts.

Every mutation:
  1. opens a transaction,
  2. locks the affected Account rows FOR UPDATE, ordered by pk (deadlock
     avoidance when a transfer touches two accounts),
  3. checks the invariant for the resulting state,
  4. appends ledger rows,
  5. updates the cached balance.

This mirrors inventory.services deliberately.  If you are changing something
here, read that file first -- the two are meant to stay recognisably the same
shape, because the invariants are the same shape.

docs/architecture/finance.md - ADR-0011 - CLAUDE.md section 3.3
"""

from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from django.db import transaction
from django.db.models import Sum
from django.utils import timezone

from accounts.models import Branch, User
from core import audit
from core.exceptions import InsufficientFunds, ValidationError
from core.money import ZERO, format_money, quantize
from finance.models import (
    METHOD_TO_KIND,
    REASON_REQUIRED,
    TRANSACTION_SIGN,
    Account,
    AccountKind,
    AccountTransaction,
    AccountTransactionType,
    AccountTransfer,
)


@dataclass(frozen=True)
class IntegrityIssue:
    account_id: str
    account_name: str
    branch_code: str
    cached_balance: Decimal
    ledger_balance: Decimal

    @property
    def drift(self) -> Decimal:
        return quantize(self.cached_balance - self.ledger_balance)


def _account_id(account: Any) -> Any:
    return getattr(account, "pk", account)


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------


@transaction.atomic
def create_account(
    *,
    branch: Branch,
    name: str,
    kind: str = AccountKind.CASH,
    opening_balance: Decimal | None = None,
    account_number: str = "",
    bank_name: str = "",
    is_default: bool = False,
    allow_overdraft: bool = False,
    notes: str = "",
    actor: User | None = None,
) -> Account:
    """Open an account, posting its opening balance as a ledger row.

    The opening balance is deliberately NOT a column.  It is an ``OPENING``
    transaction, so ``balance == SUM(transactions.amount)`` holds from the very
    first row with no special case -- which is what makes verify_integrity()
    able to prove the cache honest.
    """
    name = (name or "").strip()
    if not name:
        raise ValidationError("An account needs a name.")

    opening = quantize(opening_balance or ZERO)
    if opening < ZERO and not allow_overdraft:
        raise ValidationError("An opening balance cannot be negative unless overdraft is allowed.")

    if is_default:
        # One default per (branch, kind) is a database constraint; clear the
        # incumbent inside the same transaction rather than letting it raise.
        Account.objects.filter(branch=branch, kind=kind, is_default=True).update(is_default=False)

    account = Account.objects.create(
        branch=branch,
        name=name,
        kind=kind,
        account_number=account_number,
        bank_name=bank_name,
        is_default=is_default,
        allow_overdraft=allow_overdraft,
        notes=notes,
        balance=ZERO,
        created_by=actor,
    )

    if opening != ZERO:
        record_movement(
            account=account,
            transaction_type=AccountTransactionType.OPENING,
            amount=opening,
            actor=actor,
            reference_type="account",
            reference_id=account.pk,
            reason="Opening balance",
        )
        account.refresh_from_db(fields=["balance"])

    audit.record(
        action=audit.AuditAction.SETTINGS_CHANGED,
        entity=account,
        actor=actor,
        new_values={"name": name, "kind": kind, "opening_balance": opening},
        reason="Account opened",
        branch=branch,
    )
    return account


@transaction.atomic
def update_account(
    *,
    account: Account,
    actor: User | None = None,
    **fields: Any,
) -> Account:
    """Edit an account's descriptive fields.  Never its balance.

    ``balance`` is a cache over the ledger; the only way to change it is to
    append a movement.  Passing it here is a programming error, not a
    permission question, so it raises rather than being silently dropped.
    """
    if "balance" in fields:
        raise ValidationError(
            "An account balance cannot be set directly. Post an adjustment instead."
        )

    editable = {
        "name",
        "kind",
        "account_number",
        "bank_name",
        "is_active",
        "is_default",
        "allow_overdraft",
        "notes",
    }
    unknown = set(fields) - editable
    if unknown:
        raise ValidationError(f"Cannot edit {', '.join(sorted(unknown))} on an account.")

    before = {key: getattr(account, key) for key in fields}

    if fields.get("is_default"):
        kind = fields.get("kind", account.kind)
        Account.objects.filter(branch=account.branch, kind=kind, is_default=True).exclude(
            pk=account.pk
        ).update(is_default=False)

    for key, value in fields.items():
        setattr(account, key, value)
    account.save(update_fields=[*fields.keys(), "updated_at"])

    old_values, new_values = audit.diff(before, fields)
    if new_values:
        audit.record(
            action=audit.AuditAction.SETTINGS_CHANGED,
            entity=account,
            actor=actor,
            old_values=old_values,
            new_values=new_values,
            branch=account.branch,
        )
    return account


def resolve_account(
    *,
    branch: Branch,
    method: str | None = None,
    kind: str | None = None,
) -> Account | None:
    """Which account should this branch's money of this kind land in?

    Returns ``None`` rather than guessing when the branch has no account able
    to hold it.  Posting card takings into the cash drawer would make the
    drawer impossible to reconcile, so an honest gap beats a plausible lie --
    and ``verify_accounts`` reports every gap it causes.
    """
    target_kind = kind or METHOD_TO_KIND.get(str(method or "").upper())
    if target_kind is None:
        return None

    base = Account.objects.filter(branch=branch, kind=target_kind, is_active=True)
    return base.filter(is_default=True).first() or base.order_by("name").first()


# ---------------------------------------------------------------------------
# Movements
# ---------------------------------------------------------------------------


def _lock_accounts(account_ids: Sequence[Any]) -> dict[str, Account]:
    """Lock accounts FOR UPDATE ordered by pk.

    Consistent lock ordering is what stops two transfers between the same pair
    of accounts deadlocking on each other.
    """
    unique_ids = list(dict.fromkeys(str(a) for a in account_ids))
    locked = Account.objects.select_for_update().filter(pk__in=unique_ids).order_by("pk")
    found = {str(account.pk): account for account in locked}
    missing = set(unique_ids) - set(found)
    if missing:
        raise ValidationError(f"No such account: {', '.join(sorted(missing))}.")
    return found


def _apply(
    *,
    account: Account,
    transaction_type: str,
    delta: Decimal,
    actor: User | None,
    reference_type: str,
    reference_id: Any,
    reason: str,
    notes: str,
    occurred_at: Any,
) -> AccountTransaction:
    """Apply ``delta`` to the locked row and append the matching ledger entry."""
    account.balance = quantize(account.balance + delta)
    account.save(update_fields=["balance", "updated_at"])

    return AccountTransaction.objects.create(
        account=account,
        transaction_type=transaction_type,
        amount=delta,
        balance_after=account.balance,
        reference_type=reference_type or "manual",
        reference_id=str(reference_id) if reference_id else "",
        reason=reason,
        notes=notes,
        occurred_at=occurred_at or timezone.now(),
        created_by=actor,
    )


def _check_can_reduce(account: Account, delta: Decimal) -> None:
    if delta >= ZERO:
        return
    if account.balance + delta < ZERO and not account.allow_overdraft:
        # Formatted, because this message is shown verbatim on a money screen
        # and "65450.00" beside "৳ 65,450.00" reads as a different number.
        raise InsufficientFunds(
            f"{account.name} holds {format_money(account.balance)}, which is less than the "
            f"{format_money(abs(delta))} this would take out.",
            details={
                "account_id": str(account.pk),
                "account": account.name,
                "balance": str(account.balance),
                "requested": str(abs(delta)),
            },
        )


@transaction.atomic
def record_movement(
    *,
    account: Any,
    transaction_type: str,
    amount: Decimal,
    actor: User | None = None,
    reference_type: str = "",
    reference_id: Any = None,
    reason: str = "",
    notes: str = "",
    occurred_at: Any = None,
) -> AccountTransaction:
    """Append one movement to an account's cash book.

    ``amount`` is the absolute figure for every type except ``ADJUSTMENT``,
    which carries its own sign because the caller states the delta -- the same
    contract as inventory.services.apply_transaction().
    """
    sign = TRANSACTION_SIGN.get(transaction_type)
    if sign is None:
        raise ValidationError(f"{transaction_type} is not a valid account transaction type.")

    amount = quantize(amount)
    if sign == 0:
        delta = amount
        if delta == ZERO:
            raise ValidationError("An adjustment of zero changes nothing.")
    else:
        if amount <= ZERO:
            raise ValidationError("A movement amount must be positive.")
        delta = quantize(amount * sign)

    if transaction_type in REASON_REQUIRED and not reason.strip():
        raise ValidationError(f"A {transaction_type} needs a reason.")

    locked = _lock_accounts([_account_id(account)])
    locked_account = locked[str(_account_id(account))]

    if not locked_account.is_active:
        raise ValidationError(f"{locked_account.name} is closed; money cannot move through it.")

    _check_can_reduce(locked_account, delta)

    entry = _apply(
        account=locked_account,
        transaction_type=transaction_type,
        delta=delta,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        notes=notes,
        occurred_at=occurred_at,
    )

    # Manual movements are the ones a person chose to make, so they are the
    # ones worth an audit entry of their own.  Movements posted as a side
    # effect of a sale or a supplier payment are already audited by the
    # service that caused them.
    if reference_type in {"", "manual", "account"}:
        audit.record(
            action=audit.AuditAction.PAYMENT_RECORDED,
            entity=entry,
            entity_label=f"{locked_account.name} {delta:+}",
            actor=actor,
            new_values={
                "account": locked_account.name,
                "type": transaction_type,
                "amount": delta,
                "balance_after": locked_account.balance,
            },
            reason=reason,
            branch=locked_account.branch,
        )
    return entry


def record_for_reference(
    *,
    branch: Branch,
    transaction_type: str,
    amount: Decimal,
    reference_type: str,
    reference_id: Any,
    account: Any = None,
    method: str | None = None,
    actor: User | None = None,
    reason: str = "",
    notes: str = "",
    occurred_at: Any = None,
) -> AccountTransaction | None:
    """Post a movement caused by a business event elsewhere (a sale, a refund).

    Takes plain arguments rather than an ``Order`` or a ``Payment`` so that
    ``finance`` never imports ``orders`` or ``purchasing`` -- the dependency
    runs one way only.

    Returns ``None`` when no account can be resolved.  The causing event still
    succeeds: a shop that has not set its accounts up yet must still be able to
    sell.  ``verify_accounts`` lists every event that posted nothing, so the
    gap is reported rather than hidden.
    """
    resolved = account or resolve_account(branch=branch, method=method)
    if resolved is None:
        return None
    return record_movement(
        account=resolved,
        transaction_type=transaction_type,
        amount=amount,
        actor=actor,
        reference_type=reference_type,
        reference_id=reference_id,
        reason=reason,
        notes=notes,
        occurred_at=occurred_at,
    )


@transaction.atomic
def transfer(
    *,
    source_account: Any,
    target_account: Any,
    amount: Decimal,
    actor: User | None = None,
    notes: str = "",
    occurred_at: Any = None,
) -> AccountTransfer:
    """Move money between two of the business's own accounts.

    TRANSFER_OUT and TRANSFER_IN in one transaction, so the pair can never be
    half-applied: a bank run that credits the bank without debiting the drawer
    would invent money.
    """
    from core.services import next_number

    source_id = _account_id(source_account)
    target_id = _account_id(target_account)
    if str(source_id) == str(target_id):
        raise ValidationError("Source and destination accounts must differ.")

    amount = quantize(amount)
    if amount <= ZERO:
        raise ValidationError("A transfer amount must be positive.")

    locked = _lock_accounts([source_id, target_id])
    source = locked[str(source_id)]
    target = locked[str(target_id)]

    for account in (source, target):
        if not account.is_active:
            raise ValidationError(f"{account.name} is closed; money cannot move through it.")

    _check_can_reduce(source, -amount)

    when = occurred_at or timezone.now()
    record = AccountTransfer.objects.create(
        number=next_number("account_transfer", prefix="ATR"),
        source_account=source,
        target_account=target,
        amount=amount,
        occurred_at=when,
        notes=notes,
        created_by=actor,
    )

    _apply(
        account=source,
        transaction_type=AccountTransactionType.TRANSFER_OUT,
        delta=-amount,
        actor=actor,
        reference_type="account_transfer",
        reference_id=record.pk,
        reason="",
        notes=notes,
        occurred_at=when,
    )
    _apply(
        account=target,
        transaction_type=AccountTransactionType.TRANSFER_IN,
        delta=amount,
        actor=actor,
        reference_type="account_transfer",
        reference_id=record.pk,
        reason="",
        notes=notes,
        occurred_at=when,
    )

    audit.record(
        action=audit.AuditAction.PAYMENT_RECORDED,
        entity=record,
        actor=actor,
        new_values={
            "from": source.name,
            "to": target.name,
            "amount": amount,
        },
        reason=notes,
        branch=source.branch,
    )
    return record


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


def balance_at(*, account: Any, at: Any) -> Decimal:
    """The account's balance as at a moment, replayed from the ledger.

    Used by period reports, which must not be affected by movements posted
    after the period closed.
    """
    total = AccountTransaction.objects.filter(
        account_id=_account_id(account), occurred_at__lte=at
    ).aggregate(total=Sum("amount"))["total"]
    return quantize(total or ZERO)


def verify_integrity(*, branch: Branch | None = None) -> list[IntegrityIssue]:
    """Replay the cash book and report any drift from the cached balances.

    The money equivalent of inventory.services.verify_integrity().  Drift means
    something wrote Account.balance without appending a transaction -- a bug,
    or an out-of-band UPDATE.
    """
    accounts = Account.objects.select_related("branch")
    ledger_qs = AccountTransaction.objects.all()
    if branch is not None:
        accounts = accounts.filter(branch=branch)
        ledger_qs = ledger_qs.filter(account__branch=branch)

    totals = {
        str(row["account_id"]): quantize(row["total"] or ZERO)
        for row in ledger_qs.values("account_id").annotate(total=Sum("amount"))
    }

    issues: list[IntegrityIssue] = []
    for account in accounts:
        ledger_balance = totals.get(str(account.pk), ZERO)
        if quantize(account.balance) != ledger_balance:
            issues.append(
                IntegrityIssue(
                    account_id=str(account.pk),
                    account_name=account.name,
                    branch_code=account.branch.code,
                    cached_balance=quantize(account.balance),
                    ledger_balance=ledger_balance,
                )
            )
    return issues


@transaction.atomic
def repair_drift(*, issue: IntegrityIssue, actor: User | None = None, reason: str) -> None:
    """Reconcile a drifted cache with the cash book.

    The cached figure is the one people have been looking at, so -- exactly as
    inventory.repair_drift does -- the repair appends a row explaining the
    difference rather than silently rewriting the cache.  The ledger itself is
    never edited.
    """
    if not reason.strip():
        raise ValidationError("A repair needs a reason.")

    account = Account.objects.select_for_update().get(pk=issue.account_id)
    unexplained = quantize(account.balance - issue.ledger_balance)
    if unexplained == ZERO:
        return

    AccountTransaction.objects.create(
        account=account,
        transaction_type=AccountTransactionType.ADJUSTMENT,
        amount=unexplained,
        balance_after=account.balance,  # the cache is unchanged by this row
        reference_type="integrity_repair",
        reference_id=str(account.pk),
        reason=reason,
        notes="Appended by finance.repair_drift to explain cache/ledger drift.",
        occurred_at=timezone.now(),
        created_by=actor,
    )
    audit.record(
        action=audit.AuditAction.SETTINGS_CHANGED,
        entity=account,
        actor=actor,
        old_values={"ledger_balance": issue.ledger_balance},
        new_values={"cached_balance": account.balance, "explained_by": unexplained},
        reason=reason,
        branch=account.branch,
    )
