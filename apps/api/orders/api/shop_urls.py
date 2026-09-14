from django.urls import path

from catalog.api.feed_views import ProductFeedCSVView, ProductFeedXMLView
from content.api.views import ShopNavigationView
from orders.api.shop_views import (
    AbandonedCheckoutCaptureView,
    AccountAddressView,
    AccountOrdersView,
    CartCouponView,
    CartView,
    CheckoutView,
    OrderTrackingView,
    PaymentWebhookView,
    ShippingOptionsView,
    ShopBrandView,
    ShopCategoryView,
    ShopFacetsView,
    ShopHomeView,
    ShopProductViewSet,
    ShopSearchSuggestView,
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
    # The product feed Meta and Google poll. `.xml` and `.csv` rather than a
    # query parameter, because both platforms want a URL that ends in the
    # format they are about to parse.
    path("feed.xml", ProductFeedXMLView.as_view(), name="shop-product-feed-xml"),
    path("feed.csv", ProductFeedCSVView.as_view(), name="shop-product-feed-csv"),
    path("navigation/", ShopNavigationView.as_view(), name="shop-navigation"),
    path("brands/", ShopBrandView.as_view(), name="shop-brands"),
    path("brands/<slug:slug>/", ShopBrandView.as_view(), name="shop-brand-detail"),
    path("categories/", ShopCategoryView.as_view(), name="shop-categories"),
    path("categories/<slug:slug>/", ShopCategoryView.as_view(), name="shop-category-detail"),
    path("facets/", ShopFacetsView.as_view(), name="shop-facets"),
    path("search/suggest/", ShopSearchSuggestView.as_view(), name="shop-search-suggest"),
    path("cart/", CartView.as_view(), name="shop-cart"),
    path("cart/coupon/", CartCouponView.as_view(), name="shop-cart-coupon"),
    path("shipping-options/", ShippingOptionsView.as_view(), name="shop-shipping-options"),
    path("checkout/", CheckoutView.as_view(), name="shop-checkout"),
    # Held before the order exists, so it survives the shopper leaving.
    path(
        "checkout/lead/",
        AbandonedCheckoutCaptureView.as_view(),
        name="shop-checkout-lead",
    ),
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
