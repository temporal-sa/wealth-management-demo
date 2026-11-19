// Package redisx connects to Redis from the environment.
package redisx

import (
	"os"
	"time"

	"github.com/redis/go-redis/v9"
)

// Addr describes where Redis is, from the same settings as NewClient, without the password.
func Addr() string {
	if url := os.Getenv("REDIS_URL"); url != "" {
		if opts, err := redis.ParseURL(url); err == nil {
			return opts.Addr
		}
		return "REDIS_URL (unparseable)"
	}
	host := os.Getenv("REDIS_HOST")
	if host == "" {
		host = "localhost"
	}
	port := os.Getenv("REDIS_PORT")
	if port == "" {
		port = "6379"
	}
	return host + ":" + port
}

// NewClient returns a Redis client. REDIS_URL (redis://:<password>@<host>:<port>/<db>)
// wins when it is set; otherwise REDIS_HOST, REDIS_PORT and the optional
// REDIS_PASSWORD are used. With nothing set, it is an unauthenticated Redis on
// localhost:6379.
//
// Timeouts are short, so an unreachable Redis is noticed quickly: the chaos flags then
// read as off instead of slowing down every activity.
func NewClient() *redis.Client {
	if url := os.Getenv("REDIS_URL"); url != "" {
		if opts, err := redis.ParseURL(url); err == nil {
			applyTimeouts(opts)
			return redis.NewClient(opts)
		}
	}
	host := os.Getenv("REDIS_HOST")
	if host == "" {
		host = "localhost"
	}
	port := os.Getenv("REDIS_PORT")
	if port == "" {
		port = "6379"
	}
	opts := &redis.Options{Addr: host + ":" + port, Password: os.Getenv("REDIS_PASSWORD")}
	applyTimeouts(opts)
	return redis.NewClient(opts)
}

func applyTimeouts(opts *redis.Options) {
	opts.DialTimeout = time.Second
	opts.ReadTimeout = 2 * time.Second
	opts.WriteTimeout = 2 * time.Second
	opts.MaxRetries = 0
}
