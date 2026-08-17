"""/api/v1/ router.

Namespaces (docs/api/conventions.md):
    auth/   public authentication
    shop/   public storefront + customer account
    pos/    cashier operations
    rest    staff back office
"""

from django.urls import include, path
from rest_framework.routers import DefaultRouter

from accounts.api.views import (
    AuditLogViewSet,
    BranchViewSet,
    OrganizationView,
    PermissionViewSet,
    RoleViewSet,
    UserViewSet,
)
from catalog.api.views import (
    AttributeValueViewSet,
    AttributeViewSet,
    BrandViewSet,
    CategoryViewSet,
    ProductImageViewSet,
    ProductVariantViewSet,
    ProductViewSet,
)
from customers.api.views import CustomerViewSet
from engagement.api.views import ReviewModerationViewSet
from inventory.api.views import (
    InventoryTransactionViewSet,
    InventoryViewSet,
    StockCountViewSet,
    StockTransferViewSet,
)
from orders.api.views import OrderViewSet, ReturnRequestViewSet
from promotions.api.views import CouponViewSet
from purchasing.api.views import (
    PurchaseOrderViewSet,
    SupplierPaymentViewSet,
    SupplierViewSet,
)
from shipping.api.views import (
    CourierViewSet,
    ShipmentViewSet,
    ShippingMethodViewSet,
    ShippingZoneViewSet,
)

router = DefaultRouter()

# --- organisation & people -------------------------------------------------
router.register("branches", BranchViewSet, basename="branch")
router.register("users", UserViewSet, basename="user")
router.register("roles", RoleViewSet, basename="role")
router.register("permissions", PermissionViewSet, basename="permission")
router.register("audit-logs", AuditLogViewSet, basename="auditlog")

# --- catalog ---------------------------------------------------------------
router.register("categories", CategoryViewSet, basename="category")
router.register("brands", BrandViewSet, basename="brand")
router.register("attributes", AttributeViewSet, basename="attribute")
router.register("attribute-values", AttributeValueViewSet, basename="attributevalue")
router.register("products", ProductViewSet, basename="product")
router.register("variants", ProductVariantViewSet, basename="variant")
router.register("product-images", ProductImageViewSet, basename="productimage")

# --- inventory -------------------------------------------------------------
router.register("inventory", InventoryViewSet, basename="inventory")
router.register(
    "inventory-transactions", InventoryTransactionViewSet, basename="inventorytransaction"
)
router.register("stock-transfers", StockTransferViewSet, basename="stocktransfer")
router.register("stock-counts", StockCountViewSet, basename="stockcount")

# --- purchasing ------------------------------------------------------------
router.register("suppliers", SupplierViewSet, basename="supplier")
router.register("purchase-orders", PurchaseOrderViewSet, basename="purchaseorder")
router.register("supplier-payments", SupplierPaymentViewSet, basename="supplierpayment")

# --- customers -------------------------------------------------------------
router.register("customers", CustomerViewSet, basename="customer")

# --- orders ----------------------------------------------------------------
router.register("orders", OrderViewSet, basename="order")
router.register("returns", ReturnRequestViewSet, basename="return")

# --- shipping / promotions / content --------------------------------------
router.register("shipping-zones", ShippingZoneViewSet, basename="shippingzone")
router.register("shipping-methods", ShippingMethodViewSet, basename="shippingmethod")
router.register("couriers", CourierViewSet, basename="courier")
router.register("shipments", ShipmentViewSet, basename="shipment")
router.register("coupons", CouponViewSet, basename="coupon")
router.register("reviews", ReviewModerationViewSet, basename="review-moderation")

urlpatterns = [
    path("auth/", include("accounts.api.urls")),
    path("organization/", OrganizationView.as_view(), name="organization"),
    path("shop/", include("orders.api.shop_urls")),
    path("pos/", include("orders.api.pos_urls")),
    path("reports/", include("reports.api.urls")),
    path("notifications/", include("notifications.api.urls")),
    path("", include(router.urls)),
]
