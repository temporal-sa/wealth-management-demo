# The Go framework's Temporal worker (src/go/google_adk). Built from the repository root. Configured only through
# the environment, as the other workers.
FROM golang:1.26 AS build
WORKDIR /src
COPY src/go/go.mod src/go/go.sum ./
RUN go mod download
COPY src/go ./
RUN CGO_ENABLED=0 go build -trimpath -o /out/worker ./google_adk/cmd/worker

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/worker /worker
COPY data /app/data
ENV DATA_DIR=/app/data
CMD ["/worker"]
