package testfixtures

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
	"go.temporal.io/sdk/workflow"
)

// InActivity runs fn inside a real activity (with a real activity ctx) of a test workflow with
// the given workflow ID, for code that finds its browser session from the running workflow's ID.
// It fails the test if fn returns an error.
func InActivity(t testing.TB, workflowID string, fn func(ctx context.Context) error) {
	t.Helper()
	var suite testsuite.WorkflowTestSuite
	env := suite.NewTestWorkflowEnvironment()
	env.RegisterActivityWithOptions(fn, activity.RegisterOptions{Name: "in_activity"})
	env.RegisterWorkflowWithOptions(func(ctx workflow.Context) error {
		ctx = workflow.WithActivityOptions(ctx, workflow.ActivityOptions{
			StartToCloseTimeout: time.Minute,
			RetryPolicy:         &temporal.RetryPolicy{MaximumAttempts: 1},
		})
		return workflow.ExecuteActivity(ctx, "in_activity").Get(ctx, nil)
	}, workflow.RegisterOptions{Name: "in_activity_workflow"})
	env.SetStartWorkflowOptions(client.StartWorkflowOptions{ID: workflowID, TaskQueue: "test"})
	env.ExecuteWorkflow("in_activity_workflow")
	require.True(t, env.IsWorkflowCompleted())
	require.NoError(t, env.GetWorkflowError())
}
