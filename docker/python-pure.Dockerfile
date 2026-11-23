# The pure framework's Temporal worker (src/python/pure), for the hosted demo and docker-compose.yml.
# Built from the repository root. Configured only through the environment: the Temporal connection
# (TEMPORAL_ADDRESS, TEMPORAL_NAMESPACE, TEMPORAL_API_KEY, TEMPORAL_TLS), Redis (REDIS_URL or REDIS_HOST, REDIS_PORT,
# REDIS_PASSWORD), DEMO_DATA_STORE and the model key. data/ is the read-only seed: with DEMO_DATA_STORE=redis
# each browser session's copy lives in Redis.
FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1
# The repository's layout, which the code finds data/ and src/python/common by
WORKDIR /app/src/python/pure
COPY src/python/pure/pyproject.toml src/python/pure/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src/python/common /app/src/python/common
COPY src/python/pure ./
RUN uv sync --frozen --no-dev
COPY data /app/data
ENV PATH=/app/src/python/pure/.venv/bin:$PATH
RUN useradd --uid 10001 --no-create-home app
USER 10001
WORKDIR /app/src/python/pure/durable
CMD ["python", "run_worker.py"]
