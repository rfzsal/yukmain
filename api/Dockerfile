FROM golang:1.23-alpine AS builder
WORKDIR /src
COPY go.mod ./
COPY *.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /yukmain-api .

FROM alpine:3.21
RUN addgroup -S app && adduser -S -G app app
COPY --from=builder /yukmain-api /usr/local/bin/yukmain-api
USER app
EXPOSE 8080
CMD ["/usr/local/bin/yukmain-api"]
