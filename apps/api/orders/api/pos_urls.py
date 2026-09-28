from django.urls import include, path
from rest_framework.routers import DefaultRouter

from orders.api.pos_views import (
    HeldSaleViewSet,
    PosElevateView,
    PosLookupView,
    PosProductSearchView,
    PosQuoteView,
    PosReturnView,
    PosSaleViewSet,
    PosSessionView,
)

router = DefaultRouter()
router.register("sales", PosSaleViewSet, basename="pos-sale")
router.register("holds", HeldSaleViewSet, basename="pos-hold")

urlpatterns = [
    path("session/", PosSessionView.as_view(), name="pos-session"),
    path("lookup/", PosLookupView.as_view(), name="pos-lookup"),
    path("products/", PosProductSearchView.as_view(), name="pos-products"),
    path("quote/", PosQuoteView.as_view(), name="pos-quote"),
    path("elevate/", PosElevateView.as_view(), name="pos-elevate"),
    path("returns/", PosReturnView.as_view(), name="pos-returns"),
    path("", include(router.urls)),
]
