# Postgres 16 + pgvector, built on the EXACT stock base the project already runs
# (postgres:16.14-alpine). Building from the same Alpine/musl base keeps the text
# collation library byte-identical, so swapping this image in over an existing data
# volume needs NO REINDEX and loses no data (verified in dev: same collation, zero
# "collation version mismatch" warnings, full test suite green). Only the `vector`
# extension is added; everything else — server binary, contrib extensions
# (pg_trgm, unaccent, btree_gin, pgcrypto, pg_stat_statements), locale — is unchanged.
#
#   base : postgres:16.14-alpine   (Alpine 3.24, PostgreSQL 16.14, LLVM 21 JIT)
#   ext  : pgvector v0.8.0
#
# After swapping the running DB to this image, enable it once per database:
#   CREATE EXTENSION IF NOT EXISTS vector;   (the semantic-search migration does this)
FROM postgres:16.14-alpine

RUN set -eux; \
    apk add --no-cache --virtual .pgvector-build build-base clang21 llvm21-dev git; \
    git clone --branch v0.8.0 --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector; \
    cd /tmp/pgvector; \
    make; \
    make install; \
    cd /; \
    rm -rf /tmp/pgvector; \
    apk del .pgvector-build
