// Package workerinfo records which model a framework's worker uses, for the web UI's sidebar: the
// same Redis hash the Python workers write (src/python/common/worker_info.py). Key Key, field the
// chat task queue, value JSON {"model": ...}. The API reads it for the frameworks whose workers are
// polling.
package workerinfo

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// Key is the Redis hash of every worker's model, by chat task queue.
const Key = "worker-info"

// PublishModel records this worker's model. A Redis failure is logged and ignored: the worker runs
// without it.
func PublishModel(ctx context.Context, rdb redis.Cmdable, taskQueue, model string) {
	value, _ := json.Marshal(map[string]string{"model": model})
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := rdb.HSet(ctx, Key, taskQueue, string(value)).Err(); err != nil {
		log.Printf("Couldn't record the model in Redis, so the web UI won't show it: %v", err)
	}
}
