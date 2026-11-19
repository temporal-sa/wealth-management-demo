package config

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// TestOpenAccountTaskQueue: the open-account workflow's task queue, the same rule as the other
// languages' frameworks.
func TestOpenAccountTaskQueue(t *testing.T) {
	for _, value := range []string{"", "  "} {
		assert.Equal(t, "ADK-Go-Supervisor", OpenAccountTaskQueue("ADK-Go-Supervisor", value))
	}
	for _, value := range []string{"java", "Java", " JAVA "} {
		assert.Equal(t, "ADK-Go-Supervisor-open-account", OpenAccountTaskQueue("ADK-Go-Supervisor", value))
	}
	assert.Equal(t, "My-Queue", OpenAccountTaskQueue("ADK-Go-Supervisor", "My-Queue"))
}

func TestLoadUsesThePortsQueues(t *testing.T) {
	t.Setenv("TEMPORAL_TASK_QUEUE", "")
	t.Setenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT", "java")
	t.Setenv("TEMPORAL_TASK_QUEUE_LLM", "")
	c := Load()
	assert.Equal(t, DefaultTaskQueue, c.TaskQueue)
	assert.Equal(t, DefaultTaskQueue+"-open-account", c.TaskQueueOpenAccount)
	assert.Equal(t, DefaultTaskQueue+"-llm", c.TaskQueueLLM)
}
