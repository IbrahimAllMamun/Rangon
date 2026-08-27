from __future__ import annotations

from typing import Any

from django.db.models import Count, Q
from django_filters.rest_framework import DjangoFilterBackend
from rest_framework import mixins, status, viewsets
from rest_framework.decorators import action
from rest_framework.filters import OrderingFilter, SearchFilter
from rest_framework.parsers import FormParser, JSONParser, MultiPartParser
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

from accounts.permissions import RolePermission
from accounts.services import branch_queryset, resolve_branch
from finance import selectors
from finance import services as finance_services
from finance.api.serializers import (
    AccountSerializer,
    AccountTransactionSerializer,
    AccountTransferSerializer,
    CreateExpenseSerializer,
    CreateTransferSerializer,
    ExpenseCategorySerializer,
    ExpenseSerializer,
    RecordMovementSerializer,
    VoidExpenseSerializer,
)
from finance.models import (
    Account,
    AccountTransaction,
    AccountTransfer,
    ExpenseCategory,
    ExpenseStatus,
)


class AccountViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """Accounts and the cash book.

    There is deliberately no `destroy`: an account with movements against it is
    financial history (CLAUDE.md section 3.3).  Close it with `is_active=false`
    instead -- the balance and the ledger stay readable.
    """

    serializer_class = AccountSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["finance.view"],
        "retrieve": ["finance.view"],
        "create": ["finance.manage"],
        "update": ["finance.manage"],
        "partial_update": ["finance.manage"],
        "transactions": ["finance.view"],
        "cash_position": ["finance.view"],
        "record_movement": ["finance.adjust"],
        "verify_integrity": ["settings.manage"],
    }
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ["branch", "kind", "is_active"]
    search_fields = ["name", "account_number", "bank_name"]
    ordering_fields = ["name", "balance", "created_at"]

    def get_queryset(self) -> Any:
        queryset = Account.objects.select_related("branch")
        return branch_queryset(self.request.user, queryset).order_by("branch__name", "kind", "name")

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # ModelSerializer resolves `branch` to a Branch instance, but a bare
        # `pk=` lookup against a UUID primary key does not unwrap one.
        submitted = data.get("branch")
        branch = resolve_branch(request.user, getattr(submitted, "pk", submitted))

        account = finance_services.create_account(
            branch=branch,
            name=data["name"],
            kind=data.get("kind", Account._meta.get_field("kind").default),
            opening_balance=data.get("opening_balance"),
            account_number=data.get("account_number", ""),
            bank_name=data.get("bank_name", ""),
            is_default=data.get("is_default", False),
            allow_overdraft=data.get("allow_overdraft", False),
            notes=data.get("notes", ""),
            actor=request.user,
        )
        return Response(
            AccountSerializer(account).data,
            status=status.HTTP_201_CREATED,
        )

    def update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        account = self.get_object()
        serializer = self.get_serializer(account, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)

        editable = {
            key: value
            for key, value in serializer.validated_data.items()
            if key not in {"branch", "opening_balance"}
        }
        account = finance_services.update_account(account=account, actor=request.user, **editable)
        return Response(AccountSerializer(account).data)

    @action(detail=True, methods=["get"])
    def transactions(self, request: Request, pk: str | None = None) -> Response:
        """This account's cash book, newest first."""
        account = self.get_object()
        queryset = selectors.ledger(
            account=account,
            date_from=request.query_params.get("date_from") or None,
            date_to=request.query_params.get("date_to") or None,
            transaction_type=request.query_params.get("transaction_type") or None,
        )
        page = self.paginate_queryset(queryset)
        serializer = AccountTransactionSerializer(page if page is not None else queryset, many=True)
        if page is not None:
            return self.get_paginated_response(serializer.data)
        return Response(serializer.data)

    @action(detail=False, methods=["get"], url_path="cash-position")
    def cash_position(self, request: Request) -> Response:
        """What the business is holding right now, split by kind."""
        branch = None
        if branch_id := request.query_params.get("branch"):
            branch = resolve_branch(request.user, branch_id)
        elif not request.user.can_cross_branch and request.user.branch_id:
            branch = request.user.branch

        position = selectors.cash_position(branch=branch)
        position["movements"] = selectors.movement_totals(
            branch=branch,
            date_from=request.query_params.get("date_from") or None,
            date_to=request.query_params.get("date_to") or None,
        )
        return Response(position)

    @action(detail=False, methods=["post"], url_path="record-movement")
    def record_movement(self, request: Request) -> Response:
        """A manual deposit, withdrawal or correction."""
        serializer = RecordMovementSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # Branch scoping is enforced here too: a cashier at one branch must not
        # be able to move money in another branch's drawer by posting its id.
        resolve_branch(request.user, data["account"].branch_id)

        entry = finance_services.record_movement(
            account=data["account"],
            transaction_type=data["transaction_type"],
            amount=data["amount"],
            reason=data.get("reason", ""),
            notes=data.get("notes", ""),
            occurred_at=data.get("occurred_at"),
            actor=request.user,
        )
        return Response(AccountTransactionSerializer(entry).data, status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["post"], url_path="verify-integrity")
    def verify_integrity(self, request: Request) -> Response:
        branch = (
            resolve_branch(request.user, request.data.get("branch"))
            if request.data.get("branch")
            else None
        )
        issues = finance_services.verify_integrity(branch=branch)
        return Response(
            {
                "clean": not issues,
                "issue_count": len(issues),
                "issues": [
                    {
                        "account_id": issue.account_id,
                        "account": issue.account_name,
                        "branch": issue.branch_code,
                        "cached_balance": str(issue.cached_balance),
                        "ledger_balance": str(issue.ledger_balance),
                        "drift": str(issue.drift),
                    }
                    for issue in issues
                ],
            }
        )


class AccountTransactionViewSet(
    mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet
):
    """The whole cash book across accounts.  Read-only: the ledger is history."""

    serializer_class = AccountTransactionSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {"list": ["finance.view"], "retrieve": ["finance.view"]}
    filterset_fields = ["account", "transaction_type", "reference_type"]
    ordering_fields = ["occurred_at", "amount"]

    def get_queryset(self) -> Any:
        queryset = AccountTransaction.objects.select_related(
            "account", "account__branch", "created_by"
        )
        queryset = branch_queryset(self.request.user, queryset, field="account__branch")

        params = self.request.query_params
        if date_from := params.get("date_from"):
            queryset = queryset.filter(occurred_at__gte=date_from)
        if date_to := params.get("date_to"):
            queryset = queryset.filter(occurred_at__lte=date_to)
        return queryset.order_by("-occurred_at", "-created_at")


class AccountTransferViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    serializer_class = AccountTransferSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["finance.view"],
        "retrieve": ["finance.view"],
        "create": ["finance.transfer"],
    }
    ordering_fields = ["occurred_at", "amount"]

    def get_queryset(self) -> Any:
        queryset = AccountTransfer.objects.select_related(
            "source_account", "target_account", "created_by"
        )
        return branch_queryset(
            self.request.user, queryset, field="source_account__branch"
        ).order_by("-occurred_at")

    def get_serializer_class(self) -> Any:
        return CreateTransferSerializer if self.action == "create" else AccountTransferSerializer

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = CreateTransferSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # Both ends must be branches this user may act on.
        resolve_branch(request.user, data["source_account"].branch_id)
        resolve_branch(request.user, data["target_account"].branch_id)

        record = finance_services.transfer(
            source_account=data["source_account"],
            target_account=data["target_account"],
            amount=data["amount"],
            notes=data.get("notes", ""),
            occurred_at=data.get("occurred_at"),
            actor=request.user,
        )
        return Response(AccountTransferSerializer(record).data, status=status.HTTP_201_CREATED)


class ExpenseCategoryViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    mixins.UpdateModelMixin,
    viewsets.GenericViewSet,
):
    """What money is spent on.

    No `destroy`: a category an expense was filed under is part of that
    expense's history.  Retire it with `is_active=false` and it disappears from
    the picker while every past total stays readable.
    """

    serializer_class = ExpenseCategorySerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["finance.view"],
        "retrieve": ["finance.view"],
        "create": ["finance.manage"],
        "update": ["finance.manage"],
        "partial_update": ["finance.manage"],
    }
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ["is_active"]
    search_fields = ["name", "code", "description"]
    ordering_fields = ["name", "created_at"]

    def get_queryset(self) -> Any:
        return ExpenseCategory.objects.annotate(
            expense_count=Count("expenses", filter=Q(expenses__status=ExpenseStatus.RECORDED))
        ).order_by("name")

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        category = finance_services.create_expense_category(
            name=data["name"],
            code=data.get("code", ""),
            description=data.get("description", ""),
            is_active=data.get("is_active", True),
            actor=request.user,
        )
        return Response(ExpenseCategorySerializer(category).data, status=status.HTTP_201_CREATED)

    def update(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        category = self.get_object()
        serializer = self.get_serializer(category, data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        category = finance_services.update_expense_category(
            category=category, actor=request.user, **serializer.validated_data
        )
        return Response(ExpenseCategorySerializer(category).data)


class ExpenseViewSet(
    mixins.ListModelMixin,
    mixins.RetrieveModelMixin,
    mixins.CreateModelMixin,
    viewsets.GenericViewSet,
):
    """Money that left the business for something other than stock or a refund.

    No `destroy` and no `update`: an expense posted to the cash book is
    financial history (CLAUDE.md section 3.3).  Undo one with `void`, which
    posts a compensating movement rather than erasing anything.
    """

    serializer_class = ExpenseSerializer
    permission_classes = [IsAuthenticated, RolePermission]
    required_permissions = {
        "list": ["finance.view"],
        "retrieve": ["finance.view"],
        "create": ["finance.expense"],
        "void": ["finance.expense"],
        "summary": ["finance.view"],
    }
    parser_classes = [JSONParser, MultiPartParser, FormParser]
    filter_backends = [DjangoFilterBackend, SearchFilter, OrderingFilter]
    filterset_fields = ["branch", "category", "account", "status"]
    search_fields = ["number", "note", "category__name"]
    ordering_fields = ["spent_at", "amount", "created_at"]

    def get_queryset(self) -> Any:
        params = self.request.query_params
        # `branch`, `category`, `account` and `status` come from the filterset;
        # only the date window needs doing here, because it spans two params.
        queryset = selectors.expenses(
            date_from=params.get("date_from") or None,
            date_to=params.get("date_to") or None,
            # The list shows voided rows so a correction stays visible; every
            # total still excludes them (finance.selectors.expense_totals).
            include_void=params.get("include_void", "true").lower() != "false",
        )
        return branch_queryset(self.request.user, queryset)

    def create(self, request: Request, *args: Any, **kwargs: Any) -> Response:
        serializer = CreateExpenseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        submitted = data.get("branch")
        branch = resolve_branch(
            request.user, getattr(submitted, "pk", submitted) if submitted else None
        )

        expense = finance_services.record_expense(
            branch=branch,
            category=data["category"],
            account=data["account"],
            amount=data["amount"],
            spent_at=data.get("spent_at"),
            note=data.get("note", ""),
            attachment=data.get("attachment"),
            actor=request.user,
        )
        return Response(
            ExpenseSerializer(expense, context={"request": request}).data,
            status=status.HTTP_201_CREATED,
        )

    @action(detail=True, methods=["post"])
    def void(self, request: Request, pk: str | None = None) -> Response:
        serializer = VoidExpenseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        expense = finance_services.void_expense(
            expense=self.get_object(),
            reason=serializer.validated_data["reason"],
            actor=request.user,
        )
        return Response(ExpenseSerializer(expense, context={"request": request}).data)

    @action(detail=False, methods=["get"])
    def summary(self, request: Request) -> Response:
        """Total spent in a period, split by category."""
        branch = None
        if branch_id := request.query_params.get("branch"):
            branch = resolve_branch(request.user, branch_id)
        elif not request.user.can_cross_branch and request.user.branch_id:
            branch = request.user.branch

        return Response(
            selectors.expense_totals(
                branch=branch,
                date_from=request.query_params.get("date_from") or None,
                date_to=request.query_params.get("date_to") or None,
            )
        )
