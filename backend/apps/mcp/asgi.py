"""uvicorn target for the MCP service: ``uvicorn apps.mcp.asgi:application`` (started by ``deploy.entrypoint mcp``)."""
import os

os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'config.settings.production')

import django

django.setup()

from apps.mcp.app import build_application

application = build_application()
