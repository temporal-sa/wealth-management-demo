// Command compliance sends an account opening's compliance_approved signal, as a
// compliance officer would from outside the chat.
//
// Usage: compliance <open-account workflow ID>
package main

import (
	"context"
	"fmt"
	"log"
	"os"

	"go.temporal.io/sdk/client"

	"github.com/temporal-sa/adk-go-wealth-management/internal/config"
	"github.com/temporal-sa/adk-go-wealth-management/internal/workflows"
)

func main() {
	log.Println(config.ClaimCheckStatus())
	if len(os.Args) != 2 || os.Args[1] == "" {
		fmt.Fprintln(os.Stderr, "You must specify a workflow ID")
		os.Exit(1)
	}
	id := os.Args[1]
	opts, err := config.ClientOptions()
	if err != nil {
		log.Fatalln(err)
	}
	c, err := client.Dial(opts)
	if err != nil {
		log.Fatalln("Unable to connect to Temporal:", err)
	}
	defer c.Close()
	if err := c.SignalWorkflow(context.Background(), id, "", workflows.SignalComplianceApproved, nil); err != nil {
		log.Fatalln("Unable to send compliance approval:", err)
	}
	fmt.Printf("Compliance approval sent to %s\n", id)
}
