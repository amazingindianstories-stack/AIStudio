# Build context is this directory: docker build infra/pgbouncer
FROM debian:trixie-slim@sha256:8aa5a7bf5a1955bddbe7d74fcdd0b91ab30e74362a8b73af672b0481b35b44a0
ENV DEBIAN_FRONTEND=noninteractive
# pgbouncer 1.24 (trixie) has max_prepared_statements, track_extra_parameters and per-database connect_query.
RUN apt-get update && apt-get install -y --no-install-recommends pgbouncer gettext-base openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --no-create-home --shell /usr/sbin/nologin pooler
COPY pgbouncer.ini.template /etc/pgbouncer/pgbouncer.ini.template
COPY entrypoint.sh /usr/local/bin/pgbouncer-entrypoint
USER pooler
EXPOSE 6432
ENTRYPOINT ["/usr/local/bin/pgbouncer-entrypoint"]
