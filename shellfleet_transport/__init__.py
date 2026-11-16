"""Shell Fleet transport adapter for the AIBOX fleet.

Runs on boxtest2 as the `boxtest2` user and is the single owner of the Shell
Fleet console session. Consumers (monitor, probes, archive sync, snapshot
pull, reconciler, connectivity collector) talk to it over a local Unix socket
so only one process has to understand the hub protocol.

Nothing here ever logs credentials or camera/RSTP secrets.
"""

__all__ = ["identity", "state", "core", "service"]