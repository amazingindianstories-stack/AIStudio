from django.db.models import Index


class PostgreSQLIndex(Index):
    """Preserve existing PostgreSQL names beyond Django's portable 30-char limit."""
    max_name_length = 63
