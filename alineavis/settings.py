"""
Django settings for the Ramp Metering Visualiser.

Development works out of the box. For a public deployment, set at least:
  DJANGO_SECRET_KEY   a long random string   (python -c "import secrets;print(secrets.token_urlsafe(50))")
  DJANGO_DEBUG=0
  DJANGO_ALLOWED_HOSTS=your.domain,www.your.domain
See .env.example and docs/INTEGRATION.md (Deployment).
"""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env_bool(name, default):
    return os.environ.get(name, str(default)).strip().lower() in ("1", "true", "yes", "on")


# SECURITY -------------------------------------------------------------------
# A throwaway key is used only when DEBUG is on so development needs no setup.
# When DEBUG is off, DJANGO_SECRET_KEY MUST be provided.
DEBUG = _env_bool("DJANGO_DEBUG", True)

SECRET_KEY = os.environ.get("DJANGO_SECRET_KEY")
if not SECRET_KEY:
    if DEBUG:
        SECRET_KEY = "django-insecure-dev-key-do-not-use-in-production"
    else:
        raise RuntimeError(
            "DJANGO_SECRET_KEY must be set when DJANGO_DEBUG is off. "
            'Generate one: python -c "import secrets;print(secrets.token_urlsafe(50))"'
        )

ALLOWED_HOSTS = [h.strip() for h in os.environ.get(
    "DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1").split(",") if h.strip()]
if DEBUG and "*" not in ALLOWED_HOSTS:
    ALLOWED_HOSTS.append("*")

CSRF_TRUSTED_ORIGINS = [o.strip() for o in os.environ.get(
    "DJANGO_CSRF_TRUSTED_ORIGINS", "").split(",") if o.strip()]

# APPLICATION ----------------------------------------------------------------
INSTALLED_APPS = [
    "django.contrib.staticfiles",
    "simulator",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
X_FRAME_OPTIONS = "DENY"

# WhiteNoise is optional: if it is not installed, serve static the plain way.
try:
    import whitenoise  # noqa: F401
except ImportError:
    MIDDLEWARE = [m for m in MIDDLEWARE if "whitenoise" not in m]

ROOT_URLCONF = "alineavis.urls"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [],
        "APP_DIRS": True,
        "OPTIONS": {"context_processors": []},
    },
]

WSGI_APPLICATION = "alineavis.wsgi.application"

# No database is required - the simulation is stateless and computed per request.
DATABASES = {}

# STATIC ---------------------------------------------------------------------
STATIC_URL = "static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
STORAGES = {
    "staticfiles": {
        "BACKEND": ("whitenoise.storage.CompressedManifestStaticFilesStorage"
                    if "whitenoise" in "".join(MIDDLEWARE)
                    else "django.contrib.staticfiles.storage.StaticFilesStorage"),
    },
}

# Behind a TLS-terminating proxy in production.
if not DEBUG:
    SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")
    SECURE_SSL_REDIRECT = _env_bool("DJANGO_SECURE_SSL_REDIRECT", True)
    # HSTS: start conservative; raise once you're confident all subdomains are HTTPS.
    SECURE_HSTS_SECONDS = int(os.environ.get("DJANGO_HSTS_SECONDS", "3600"))
    SECURE_HSTS_INCLUDE_SUBDOMAINS = _env_bool("DJANGO_HSTS_SUBDOMAINS", False)
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
