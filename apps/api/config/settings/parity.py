"""Settings for the Django side of the NestJS parity stack (docker-compose.nest.yml).

Development settings with the rate limits off. The parity harness sends the
same requests to both APIs from one address, hundreds a minute, and a 429 on one
side only would be a difference in the harness, not in either API. Throttling
parity is checked separately, with the limits on.

Never used in production: it inherits `dev`, which allows every host.
"""

from .dev import *
from .dev import REST_FRAMEWORK

REST_FRAMEWORK = {**REST_FRAMEWORK, "DEFAULT_THROTTLE_CLASSES": ()}
