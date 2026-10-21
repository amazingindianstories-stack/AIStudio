"""Production parity characterization tests (pinned before the Phase 2 backend restructure).

Every test here drives the backend only through seams the restructure keeps
unchanged: HTTP through ``config.wsgi`` (directly or behind ``deploy/gateway.py``),
``deploy.entrypoint`` and ``deploy.legacy_config``, management commands by name,
settings flags and environment variables, and models looked up by app label.
Nothing imports a module the restructure moves (``apps.production_runtime``,
``apps.generation.providers``, ``apps.generation.services``, ``apps.media`` or
``apps.assets`` internals); provider traffic goes through the explicit fakes in
``testsupport.fake_providers``.

Keep this package where it is and keep its expectations unchanged while code
moves: a failure here means production behaviour changed.
"""
