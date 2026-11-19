package workflows

import (
	"time"

	"go.temporal.io/sdk/client"
)

func clientStartOptions(id string) client.StartWorkflowOptions {
	return client.StartWorkflowOptions{ID: id, TaskQueue: "test"}
}

func minutes(n int) time.Duration { return time.Duration(n) * time.Minute }
