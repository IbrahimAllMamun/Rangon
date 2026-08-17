from django.urls import path

from orders.api.shop_views import (
    AccountAddressView,
    AccountOrdersView,
    CartCouponView,
    CartView,
    CheckoutView,
    OrderTrackingView,
    PaymentWebhookView,
    ShippingOptionsView,
    ShopCategoryView,
    ShopFacetsView,
    ShopHomeView,
    ShopProductViewSet,
    WishlistView,
)

product_list = ShopProductViewSet.as_view({"get": "list"})
product_detail = ShopProductViewSet.as_view({"get": "retrieve"})
product_reviews = ShopProductViewSet.as_view({"post": "reviews"})

urlpatterns = [
    path("home/", ShopHomeView.as_view(), name="shop-home"),
    path("products/", product_list, name="shop-products"),
    path("products/<slug:slug>/", product_detail, name="shop-product-detail"),
    path("products/<slug:slug>/reviews/", product_reviews, name="shop-product-reviews"),
    path("categories/", ShopCategoryView.as_view(), name="shop-categories"),
    path("categories/<slug:slug>/", ShopCategoryView.as_view(), name="shop-category-detail"),
    path("facets/", ShopFacetsView.as_view(), name="shop-facets"),
    path("cart/", CartView.as_view(), name="shop-cart"),
    path("cart/coupon/", CartCouponView.as_view(), name="shop-cart-coupon"),
    path("shipping-options/", ShippingOptionsView.as_view(), name="shop-shipping-options"),
    path("checkout/", CheckoutView.as_view(), name="shop-checkout"),
    path("orders/<str:number>/", OrderTrackingView.as_view(), name="shop-order-tracking"),
    path("account/orders/", AccountOrdersView.as_view(), name="shop-account-orders"),
    path(
        "account/orders/<str:number>/",
        AccountOrdersView.as_view(),
        name="shop-account-order-detail",
    ),
    path("account/addresses/", AccountAddressView.as_view(), name="shop-account-addresses"),
    path("wishlist/", WishlistView.as_view(), name="shop-wishlist"),
    path("payments/<str:provider>/webhook/", PaymentWebhookView.as_view(), name="shop-webhook"),
]
