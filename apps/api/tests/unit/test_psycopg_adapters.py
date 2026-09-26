"""The database driver resolves a lazily registered type without a gap.

psycopg registers some of its dumpers by *name* -- ``"ipaddress.IPv4Address"``,
``"uuid.UUID"`` -- and swaps the name for the class on first use.  Up to 3.3.1
the swap was ``dmap[cls] = dmap.pop(name)``: for a moment the map held neither,
and a second thread looking the same type up in that moment was told the type
cannot be adapted (psycopg#1230, fixed in 3.3.2).

Production runs gunicorn with ``--threads 2``, so on 2026-09-26 a login right
after a worker started failed writing ``User.last_login_ip``::

    ProgrammingError: cannot adapt type 'IPv4Address' using placeholder '%t'

The suite runs in one thread and never saw it.  Every primary key here is a
UUID, which goes through the same swap, so any pair of concurrent first requests
could have failed the same way.

This reaches into psycopg's private map because that is where the gap was.  If
psycopg reshapes it and this fails on an ``AttributeError``, check whether the
#1230 fix is still in the release before rewriting the test around it.
"""

from __future__ import annotations

from ipaddress import IPv4Address

from psycopg import postgres
from psycopg.adapt import AdaptersMap, PyFormat
from psycopg.types import net


def test_a_second_thread_mid_swap_still_finds_the_dumper():
    # A fresh map, not `psycopg.adapters`: by the time this runs in the full
    # suite, Django has already resolved the global one's IPv4Address entry.
    adapters = AdaptersMap(types=postgres.types)
    net.register_default_adapters(adapters)
    interleaved = []

    class SecondThreadAtThePop(dict):
        """Looks the type up again at the exact point another thread got in."""

        def pop(self, *args):
            value = super().pop(*args)
            interleaved.append(adapters.get_dumper(IPv4Address, PyFormat.TEXT))
            return value

    text_dumpers = adapters._dumpers[PyFormat.TEXT]
    assert "ipaddress.IPv4Address" in text_dumpers, "registered by name, as in production"
    adapters._dumpers[PyFormat.TEXT] = SecondThreadAtThePop(text_dumpers)

    dumper = adapters.get_dumper(IPv4Address, PyFormat.TEXT)

    assert interleaved == [dumper]
