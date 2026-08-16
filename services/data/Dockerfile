FROM python:3.12-slim AS builder

ENV PIP_DISABLE_PIP_VERSION_CHECK=1 PIP_NO_CACHE_DIR=1
WORKDIR /build
COPY services/data/pyproject.toml ./pyproject.toml
COPY services/data/app ./app
RUN python -m pip wheel --wheel-dir /wheels .

FROM python:3.12-slim AS runtime

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    ANNO_DATABASE_PATH=/data/anno-companion.sqlite3 \
    ANNO_TELEMETRY_DIR=/telemetry \
    ANNO_CATALOG_PATH=/app/catalog/anno117-community-2.1-c6a6e752.json \
    ANNO_PLANNING_CATALOG_PATH=/app/catalog/anno117-community-2.1-c6a6e752-planning.json

RUN groupadd --gid 10001 companion \
    && useradd --uid 10001 --gid companion --create-home --shell /usr/sbin/nologin companion \
    && mkdir -p /app /data /telemetry \
    && chown -R companion:companion /app /data /telemetry
COPY --from=builder /wheels /wheels
RUN python -m pip install --no-cache-dir /wheels/* && rm -rf /wheels

WORKDIR /app
COPY --chown=companion:companion services/data/app ./app
COPY --chown=companion:companion services/data/alembic ./alembic
COPY --chown=companion:companion services/data/alembic.ini ./alembic.ini
COPY --chown=companion:companion catalog ./catalog

USER companion
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2)" || exit 1
CMD ["sh", "-c", "alembic upgrade head && exec uvicorn app.main:app --host 0.0.0.0 --port 8000"]
