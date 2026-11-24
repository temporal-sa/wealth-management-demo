# The web component: the API (src/python/api), which also serves the built web app (frontend/) at /, on port 8000.
# Built from the repository root. Configured through the environment: the Temporal connection, Redis, AI_FRAMEWORK
# (the frameworks it serves, comma-separated) and DEMO_HOSTED (true on the hosted demo).

# The built web app is static files, the same for every CPU: build it on the builder's own platform
FROM --platform=$BUILDPLATFORM node:26-alpine AS webapp
WORKDIR /frontend
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM python:3.13-slim
COPY --from=ghcr.io/astral-sh/uv:0.13 /uv /usr/local/bin/uv
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PYTHON_DOWNLOADS=never \
    PYTHONUNBUFFERED=1
WORKDIR /app/src/python/api
COPY src/python/api/pyproject.toml src/python/api/uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project
COPY src/python/common /app/src/python/common
COPY src/python/api ./
RUN uv sync --frozen --no-dev
COPY --from=webapp /frontend/build /app/frontend/build
# The platform's ingress terminates TLS: trust its X-Forwarded-* headers, so the session cookie is Secure
ENV PATH=/app/src/python/api/.venv/bin:$PATH \
    WEB_APP_DIR=/app/frontend/build \
    FORWARDED_ALLOW_IPS=*
RUN useradd --uid 10001 --no-create-home app
USER 10001
EXPOSE 8000
CMD ["uvicorn", "api.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
