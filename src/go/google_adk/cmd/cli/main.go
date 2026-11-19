// Command cli is the standalone version: a command-line chat with the same agents, run
// with Google ADK alone (no Temporal). Type "end" or press Ctrl-D to leave.
package main

import (
	"bufio"
	"context"
	"fmt"
	"log"
	"os"
	"strings"

	"google.golang.org/adk/v2/agent"
	"google.golang.org/adk/v2/model/gemini"
	"google.golang.org/adk/v2/runner"
	"google.golang.org/adk/v2/session"
	"google.golang.org/genai"

	"github.com/temporal-sa/adk-go-wealth-management/internal/config"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/standalone"
)

func main() {
	ctx := context.Background()
	fmt.Println(config.ClaimCheckStatus() + ". The standalone chat doesn't use Temporal, so it has no payloads to claim-check.")
	if os.Getenv("GEMINI_API_KEY") == "" && os.Getenv("GOOGLE_API_KEY") == "" {
		log.Fatalln("Set GEMINI_API_KEY first (see setgeminikey.example).")
	}
	dataDir, err := data.FindDataDir()
	if err != nil {
		log.Fatalln(err)
	}
	cfg := config.Load()
	m, err := gemini.NewModel(ctx, cfg.GeminiModel, &genai.ClientConfig{Backend: genai.BackendGeminiAPI})
	if err != nil {
		log.Fatalln("Unable to create the Gemini model:", err)
	}
	root, err := standalone.Build(m, data.NewStore(dataDir))
	if err != nil {
		log.Fatalln(err)
	}
	r, err := runner.New(runner.Config{
		AppName:           "wealth-management",
		Agent:             root,
		SessionService:    session.InMemoryService(),
		AutoCreateSession: true,
	})
	if err != nil {
		log.Fatalln(err)
	}

	fmt.Printf("Wealth Management chat (Google ADK, %s). Type \"end\" to leave.\n", cfg.GeminiModel)
	in := bufio.NewScanner(os.Stdin)
	for {
		fmt.Print("\nEnter your message: ")
		if !in.Scan() {
			break
		}
		msg := strings.TrimSpace(in.Text())
		if msg == "" {
			continue
		}
		if strings.EqualFold(msg, "end") {
			break
		}
		for ev, err := range r.Run(ctx, "user", "session", genai.NewContentFromText(msg, genai.RoleUser), agent.RunConfig{}) {
			if err != nil {
				fmt.Println("Error:", err)
				break
			}
			if ev == nil || ev.Content == nil {
				continue
			}
			if t := ev.Actions.TransferToAgent; t != "" {
				fmt.Printf("  [%s handed off to %s]\n", ev.Author, t)
			}
			for _, p := range ev.Content.Parts {
				switch {
				case p == nil:
				case p.FunctionCall != nil && p.FunctionCall.Name != "transfer_to_agent":
					fmt.Printf("  [%s calls %s]\n", ev.Author, p.FunctionCall.Name)
				case p.Text != "" && !p.Thought:
					fmt.Printf("%s: %s\n", ev.Author, p.Text)
				}
			}
		}
	}
	fmt.Println("Goodbye.")
}
