package workerinfo

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
)

func TestPublishModel(t *testing.T) {
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	PublishModel(context.Background(), rdb, "ADK-Go-Supervisor", "gemini-3.8-flash")

	var got map[string]string
	if err := json.Unmarshal([]byte(mr.HGet(Key, "ADK-Go-Supervisor")), &got); err != nil {
		t.Fatal(err)
	}
	if got["model"] != "gemini-3.8-flash" {
		t.Fatalf("model = %q", got["model"])
	}
}

func TestPublishModelWithoutRedisDoesNotFail(t *testing.T) {
	rdb := redis.NewClient(&redis.Options{Addr: "127.0.0.1:1"})
	PublishModel(context.Background(), rdb, "q", "m") // logs, doesn't panic or block
}
