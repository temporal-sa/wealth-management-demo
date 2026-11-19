// Package testfixtures gives tests a fresh copy of the demo data, as committed in data/,
// so they don't depend on (or change) the data/ files a running demo has changed.
package testfixtures

import (
	"embed"
	"os"
	"path/filepath"
	"testing"

	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
)

//go:embed data/*.json
var demoData embed.FS

// DataDir copies the demo data into a new temporary directory and returns it.
func DataDir(t testing.TB) string {
	t.Helper()
	dir := t.TempDir()
	entries, err := demoData.ReadDir("data")
	if err != nil {
		t.Fatal(err)
	}
	for _, e := range entries {
		b, err := demoData.ReadFile("data/" + e.Name())
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, e.Name()), b, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

// Store returns a data store on a fresh copy of the demo data.
func Store(t testing.TB) *data.Store { return data.NewStore(DataDir(t)) }
