// Command worker runs the Temporal workers: one for the chat workflow, the open-account
// workflow and the tool activities, and one for the model calls on their own task queue.
package main

import (
	"log"
	"os"
	"strconv"

	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"

	"go.temporal.io/googleadk"

	"github.com/temporal-sa/adk-go-wealth-management/internal/activities"
	"github.com/temporal-sa/adk-go-wealth-management/internal/chaos"
	"github.com/temporal-sa/adk-go-wealth-management/internal/config"
	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/eventstream"
	"github.com/temporal-sa/adk-go-wealth-management/internal/llm"
	"github.com/temporal-sa/adk-go-wealth-management/internal/redisx"
	"github.com/temporal-sa/adk-go-wealth-management/internal/workflows"
)

func main() {
	log.Println(config.ClaimCheckStatus())
	cfg := config.Load()
	opts, err := config.ClientOptions()
	if err != nil {
		log.Fatalln("Unable to load the Temporal client options:", err)
	}
	c, err := client.Dial(opts)
	if err != nil {
		log.Fatalln("Unable to connect to Temporal:", err)
	}
	defer c.Close()

	dataDir, err := data.FindDataDir()
	if err != nil {
		log.Fatalln(err)
	}
	rdb := redisx.NewClient()
	defer rdb.Close()
	chaosFlags := chaos.NewManager(rdb)

	acts := &activities.Activities{
		Data:   data.NewStore(dataDir),
		Chaos:  chaosFlags,
		Events: eventstream.NewRedis(rdb),
		Client: c,
	}

	w := worker.New(c, cfg.TaskQueue, worker.Options{})
	chat := &workflows.Chat{Config: workflows.ChatConfig{
		OpenAccountTaskQueue: cfg.TaskQueueOpenAccount,
		LLMTaskQueue:         cfg.TaskQueueLLM,
		ModelName:            cfg.GeminiModel,
	}}
	w.RegisterWorkflowWithOptions(chat.Run, workflow.RegisterOptions{Name: workflows.WealthManagementWorkflowName})
	// The open-account workflow runs here unless it has its own task queue (for example
	// the other ports' Java worker).
	if cfg.TaskQueueOpenAccount == cfg.TaskQueue {
		w.RegisterWorkflowWithOptions(workflows.OpenInvestmentAccountWorkflow,
			workflow.RegisterOptions{Name: workflows.OpenInvestmentAccountWorkflowName})
	} else {
		log.Printf("Open-account workflow runs on task queue %s, not here", cfg.TaskQueueOpenAccount)
	}
	acts.Register(w)

	// Model calls run on their own task queue. The googleadk plugin registers its
	// InvokeModel activity there, and builds the real model from the factory. With
	// LLM_MAX_CALLS_PER_SECOND set, the Temporal service rate limits model calls across
	// all workers, so they queue up instead of hitting the provider's rate limit.
	plugin, err := googleadk.NewPlugin(googleadk.Config{
		Models: map[string]googleadk.ModelFactory{cfg.GeminiModel: llm.NewGeminiFactory(chaosFlags)},
	})
	if err != nil {
		log.Fatalln("Unable to build the googleadk plugin:", err)
	}
	llmWorker := worker.New(c, cfg.TaskQueueLLM, worker.Options{
		Plugins:                      []worker.Plugin{plugin},
		Interceptors:                 []interceptor.WorkerInterceptor{&llm.RateLimitInterceptor{}},
		TaskQueueActivitiesPerSecond: cfg.LLMMaxCallsPerSecond,
	})

	if os.Getenv("GEMINI_API_KEY") == "" && os.Getenv("GOOGLE_API_KEY") == "" {
		log.Println("Warning: GEMINI_API_KEY is not set, so the agents can't call the model " +
			"(see setgeminikey.example). The open-account workflow doesn't need it.")
	}
	log.Printf("Temporal %s, namespace %s", opts.HostPort, namespace(opts))
	log.Printf("Worker on task queue %s; model calls (%s) on %s, max calls per second: %s",
		cfg.TaskQueue, cfg.GeminiModel, cfg.TaskQueueLLM, rate(cfg.LLMMaxCallsPerSecond))

	if err := llmWorker.Start(); err != nil {
		log.Fatalln("Unable to start the model worker:", err)
	}
	defer llmWorker.Stop()
	if err := w.Run(worker.InterruptCh()); err != nil {
		log.Fatalln("Worker stopped:", err)
	}
}

func namespace(o client.Options) string {
	if o.Namespace == "" {
		return "default"
	}
	return o.Namespace
}

func rate(r float64) string {
	if r <= 0 {
		return "unlimited"
	}
	return strconv.FormatFloat(r, 'g', -1, 64)
}
