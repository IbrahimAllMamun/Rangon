"""Settings for the Django side of the NestJS parity stack (docker-compose.nest.yml).

Development settings with the rate limits off. The parity harness sends the
same requests to both APIs from one address, hundreds a minute, and a 429 on one
side only would be a difference in the harness, not in either API. Throttling
parity is checked separately, with the limits on.

Never used in production: it inherits `dev`, which allows every host, and it
installs a payment gateway that believes whatever it is sent.
"""

from .dev import *
from .dev import INSTALLED_APPS, REST_FRAMEWORK

REST_FRAMEWORK = {**REST_FRAMEWORK, "DEFAULT_THROTTLE_CLASSES": ()}

# A stand-in payment gateway, so a webhook can reach the capture path at all:
# `apps/api-nest/parity/gateway/`, mounted by docker-compose.nest.yml only.
INSTALLED_APPS = [*INSTALLED_APPS, "parity_gateway"]
