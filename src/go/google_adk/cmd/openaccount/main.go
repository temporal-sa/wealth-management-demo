// Command openaccount runs OpenInvestmentAccountWorkflow on its own, with no chat and no
// model, for three scenarios: KYC approved, client details updated, and compliance
// approval sent by hand (scripts/localsendcomplianceapproval.sh <workflow ID>).
//
// A worker must be running (scripts/startlocalopenaccount.sh starts one).
package main

import (
	"context"
	"log"
	"time"

	"go.temporal.io/sdk/client"

	"github.com/temporal-sa/adk-go-wealth-management/internal/config"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/workflows"
)

func main() {
	log.Println(config.ClaimCheckStatus())
	cfg := config.Load()
	opts, err := config.ClientOptions()
	if err != nil {
		log.Fatalln(err)
	}
	c, err := client.Dial(opts)
	if err != nil {
		log.Fatalln("Unable to connect to Temporal:", err)
	}
	defer c.Close()
	ctx := context.Background()

	// The open-account task queue (TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT) defaults to the chat's.
	log.Printf("Running the open-account workflow on task queue %s", cfg.TaskQueueOpenAccount)
	for _, scenario := range []func(context.Context, client.Client, string) error{scenario1, scenario2, scenario3} {
		if err := scenario(ctx, c, cfg.TaskQueueOpenAccount); err != nil {
			log.Fatalln(err)
		}
	}
	log.Println("All three scenarios completed.")
}

// scenario1: the customer confirms their details (KYC), then compliance approves.
func scenario1(ctx context.Context, c client.Client, queue string) error {
	log.Println("Scenario 1: KYC approved")
	run, err := start(ctx, c, queue, "testing-open-investment-account-workflow", "Vacation", 150.78)
	if err != nil {
		return err
	}
	waitFor(ctx, c, run, workflows.StateWaitingKYC)
	if err := c.SignalWorkflow(ctx, run.GetID(), "", workflows.SignalVerifyKYC, nil); err != nil {
		return err
	}
	waitFor(ctx, c, run, workflows.StateWaitingCompliance)
	if err := c.SignalWorkflow(ctx, run.GetID(), "", workflows.SignalComplianceApproved, nil); err != nil {
		return err
	}
	return result(ctx, run)
}

// scenario2: the customer changes a detail, which completes KYC, then compliance approves.
func scenario2(ctx context.Context, c client.Client, queue string) error {
	log.Println("Scenario 2: client details updated")
	run, err := start(ctx, c, queue, "testing-open-investment-account-workflow-2", "Vacation2", 350.72)
	if err != nil {
		return err
	}
	var details domain.WealthManagementClient
	if err := update(ctx, c, run, workflows.UpdateGetClientDetails, &details); err != nil {
		return err
	}
	log.Printf("Current client details: %+v", details)
	var msg string
	if err := update(ctx, c, run, workflows.UpdateUpdateClientDetails, &msg, map[string]any{"last_name": "Doenut"}); err != nil {
		return err
	}
	log.Printf("Update client details: %s", msg)
	waitFor(ctx, c, run, workflows.StateWaitingCompliance)
	if err := c.SignalWorkflow(ctx, run.GetID(), "", workflows.SignalComplianceApproved, nil); err != nil {
		return err
	}
	return result(ctx, run)
}

// scenario3: KYC approved, then the compliance approval is sent by hand.
func scenario3(ctx context.Context, c client.Client, queue string) error {
	log.Println("Scenario 3: compliance approval sent by hand")
	id := "testing-open-investment-account-workflow3"
	run, err := start(ctx, c, queue, id, "Vacation3", 176.73)
	if err != nil {
		return err
	}
	waitFor(ctx, c, run, workflows.StateWaitingKYC)
	if err := c.SignalWorkflow(ctx, run.GetID(), "", workflows.SignalVerifyKYC, nil); err != nil {
		return err
	}
	waitFor(ctx, c, run, workflows.StateWaitingCompliance)
	log.Printf("Waiting for compliance approval. In another terminal, from the scripts folder, run:")
	log.Printf("    ./localsendcomplianceapproval.sh %s", id)
	for state(ctx, c, run) == workflows.StateWaitingCompliance {
		time.Sleep(time.Second)
	}
	return result(ctx, run)
}

func start(ctx context.Context, c client.Client, queue, id, name string, amount float64) (client.WorkflowRun, error) {
	return c.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: id, TaskQueue: queue},
		workflows.OpenInvestmentAccountWorkflowName,
		domain.OpenInvestmentAccountInput{ClientID: "123", AccountName: name, InitialAmount: amount})
}

func update(ctx context.Context, c client.Client, run client.WorkflowRun, name string, result any, args ...any) error {
	h, err := c.UpdateWorkflow(ctx, client.UpdateWorkflowOptions{
		WorkflowID: run.GetID(), RunID: run.GetRunID(), UpdateName: name, Args: args,
		WaitForStage: client.WorkflowUpdateStageCompleted,
	})
	if err != nil {
		return err
	}
	return h.Get(ctx, result)
}

func state(ctx context.Context, c client.Client, run client.WorkflowRun) string {
	v, err := c.QueryWorkflow(ctx, run.GetID(), run.GetRunID(), workflows.QueryGetCurrentState)
	if err != nil {
		return ""
	}
	var s string
	_ = v.Get(&s)
	return s
}

func waitFor(ctx context.Context, c client.Client, run client.WorkflowRun, want string) {
	last := ""
	for {
		s := state(ctx, c, run)
		if s != last {
			log.Printf("  state: %s", s)
			last = s
		}
		if s == want {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func result(ctx context.Context, run client.WorkflowRun) error {
	var out domain.OpenInvestmentAccountOutput
	if err := run.Get(ctx, &out); err != nil {
		return err
	}
	log.Printf("  result: account_created=%v, message=%q", out.AccountCreated, out.Message)
	return nil
}
