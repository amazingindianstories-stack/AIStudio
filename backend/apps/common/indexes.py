from django.db import models


class PostgresIndex(models.Index):
    """Keep canonical live index names up to PostgreSQL's 63-byte limit."""

    max_name_length = 63
