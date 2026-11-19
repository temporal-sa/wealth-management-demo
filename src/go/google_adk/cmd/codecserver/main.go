// Command codecserver lets the Temporal UI decode claim-checked payloads. It serves
// POST /encode and POST /decode at http://127.0.0.1:8081 (CODEC_SERVER_ADDRESS changes it)
// for the local Temporal UI (http://localhost:8233) and Temporal Cloud's UI.
package main

import (
	"log"
	"net/http"
	"os"

	"go.temporal.io/sdk/converter"

	"github.com/temporal-sa/adk-go-wealth-management/internal/claimcheck"
	"github.com/temporal-sa/adk-go-wealth-management/internal/config"
	"github.com/temporal-sa/adk-go-wealth-management/internal/redisx"
)

var allowedOrigins = map[string]bool{
	"http://localhost:8233":     true,
	"http://127.0.0.1:8233":     true,
	"https://cloud.temporal.io": true,
}

func main() {
	log.Println(config.ClaimCheckStatus())
	rdb := redisx.NewClient()
	defer rdb.Close()
	handler := converter.NewPayloadCodecHTTPHandler(claimcheck.New(rdb))

	addr := os.Getenv("CODEC_SERVER_ADDRESS")
	if addr == "" {
		addr = "127.0.0.1:8081"
	}
	// It decodes claim-checked payloads whatever USE_CLAIM_CHECK says, so it can show the
	// history of runs that had the claim check on.
	log.Printf("Claim-check codec server on http://%s (POST /encode, POST /decode)", addr)
	log.Fatal(http.ListenAndServe(addr, cors(handler)))
}

func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if origin := r.Header.Get("Origin"); allowedOrigins[origin] {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Vary", "Origin")
			w.Header().Set("Access-Control-Allow-Methods", "POST, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "content-type, x-namespace, authorization")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
