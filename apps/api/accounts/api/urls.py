from django.urls import path

from accounts.api.views import (
    LoginView,
    LogoutView,
    MeView,
    PasswordChangeView,
    RefreshView,
    RegisterView,
)

urlpatterns = [
    path("login/", LoginView.as_view(), name="auth-login"),
    path("refresh/", RefreshView.as_view(), name="auth-refresh"),
    path("logout/", LogoutView.as_view(), name="auth-logout"),
    path("me/", MeView.as_view(), name="auth-me"),
    path("register/", RegisterView.as_view(), name="auth-register"),
    path("password/change/", PasswordChangeView.as_view(), name="auth-password-change"),
]
