"""The Veevee MCP server: agent tools over Streamable HTTP, served by its own async process.

``python -m deploy.entrypoint mcp`` runs ``apps.mcp.asgi:application`` under uvicorn behind the private ingress
gateway. Identity, scopes and spending controls come from ``apps.mcp_auth``; tools call the same service functions
as the web views. See ``docs/architecture/mcp-server.md``.
"""
