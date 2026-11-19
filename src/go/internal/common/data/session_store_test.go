package data_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/alicebob/miniredis/v2"
	"github.com/redis/go-redis/v9"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/data"
	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/domain"
	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/session"
	"github.com/temporal-sa/wealth-management-demo/src/go/internal/common/testfixtures"
)

func redisStore(t *testing.T) (*data.Store, string, *miniredis.Miniredis) {
	t.Helper()
	mr := miniredis.RunT(t)
	rdb := redis.NewClient(&redis.Options{Addr: mr.Addr()})
	t.Cleanup(func() { _ = rdb.Close() })
	dir := testfixtures.DataDir(t)
	return data.NewRedisStore(dir, rdb), dir, mr
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	require.NoError(t, err)
	return b
}

func beneficiaryNames(t *testing.T, list []domain.BeneficiaryRecord) []string {
	t.Helper()
	names := []string{}
	for _, b := range list {
		names = append(names, b.FirstName)
	}
	return names
}

// chatID is a chat workflow ID of the given session.
func chatID(sessionID string) string {
	return session.NewChatWorkflowID("adk-go-temporal-agent-", sessionID)
}

func TestDataStoreSetting(t *testing.T) {
	for value, want := range map[string]bool{"": false, "file": false, "redis": true, " Redis ": true, "REDIS": true, "other": false} {
		t.Setenv("DEMO_DATA_STORE", value)
		assert.Equal(t, want, data.UseRedis(), value)
	}
	assert.Equal(t, "data:abc:funding_accounts", data.RedisKey("abc", "funding_accounts"))
}

func TestFileStoreWritesTheFiles(t *testing.T) {
	dir := testfixtures.DataDir(t)
	s := data.NewStore(dir)
	var removed bool
	testfixtures.InActivity(t, chatID(session.NewSessionID()), func(ctx context.Context) error {
		var err error
		removed, err = s.DeleteBeneficiary(ctx, "123", "b-14c4b7ec")
		return err
	})
	assert.True(t, removed)
	var onDisk map[string][]domain.BeneficiaryRecord
	require.NoError(t, json.Unmarshal(readFile(t, filepath.Join(dir, "beneficiaries.json")), &onDisk))
	assert.Equal(t, []string{"John", "Jane"}, beneficiaryNames(t, onDisk["123"]))
}

func TestRedisStoreGivesEachSessionItsOwnCopy(t *testing.T) {
	s, dir, mr := redisStore(t)
	file := filepath.Join(dir, "beneficiaries.json")
	before := readFile(t, file)
	alice, bob := session.NewSessionID(), session.NewSessionID()

	testfixtures.InActivity(t, chatID(alice), func(ctx context.Context) error {
		_, err := s.DeleteBeneficiary(ctx, "123", "b-14c4b7ec")
		return err
	})
	testfixtures.InActivity(t, "OpenAccount-"+chatID(alice)+"-123-Vacation-1", func(ctx context.Context) error {
		list, err := s.ListBeneficiaries(ctx, "123")
		assert.Equal(t, []string{"John", "Jane"}, beneficiaryNames(t, list))
		return err
	})
	testfixtures.InActivity(t, chatID(bob), func(ctx context.Context) error {
		list, err := s.ListBeneficiaries(ctx, "123")
		assert.Equal(t, []string{"John", "Jane", "Joan"}, beneficiaryNames(t, list))
		return err
	})
	// Outside an activity: the default session, which hasn't changed anything either.
	list, err := s.ListBeneficiaries(context.Background(), "123")
	require.NoError(t, err)
	assert.Equal(t, []string{"John", "Jane", "Joan"}, beneficiaryNames(t, list))

	assert.Equal(t, before, readFile(t, file))
	assert.Equal(t, []string{"data:" + alice + ":beneficiaries"}, mr.Keys())
	assert.Equal(t, session.TTL, mr.TTL("data:"+alice+":beneficiaries"))
	stored, err := mr.Get("data:" + alice + ":beneficiaries")
	require.NoError(t, err)
	var copyOf map[string][]domain.BeneficiaryRecord
	require.NoError(t, json.Unmarshal([]byte(stored), &copyOf))
	assert.Equal(t, []string{"John", "Jane"}, beneficiaryNames(t, copyOf["123"]))
}

func TestRedisStoreCoversInvestmentsFundingAndClients(t *testing.T) {
	s, dir, mr := redisStore(t)
	sessionID := session.NewSessionID()
	files := map[string][]byte{}
	for _, name := range []string{"clients.json", "investments.json", "funding_accounts.json"} {
		files[name] = readFile(t, filepath.Join(dir, name))
	}

	testfixtures.InActivity(t, chatID(sessionID), func(ctx context.Context) error {
		if _, err := s.Debit(ctx, "123", 1000, "t-1"); err != nil {
			return err
		}
		if _, err := s.AddInvestment(ctx, domain.InvestmentAccount{ClientID: "123", Name: "Vacation", Balance: 1000}); err != nil {
			return err
		}
		_, err := s.UpdateClient(ctx, "123", map[string]any{"last_name": "Doenut"})
		return err
	})

	assert.ElementsMatch(t, []string{
		"data:" + sessionID + ":funding_accounts",
		"data:" + sessionID + ":investments",
		"data:" + sessionID + ":clients",
	}, mr.Keys())
	for _, k := range mr.Keys() {
		assert.Equal(t, session.TTL, mr.TTL(k), k)
	}
	for name, b := range files {
		assert.Equal(t, b, readFile(t, filepath.Join(dir, name)), name)
	}

	testfixtures.InActivity(t, chatID(sessionID), func(ctx context.Context) error {
		again, err := s.Debit(ctx, "123", 1000, "t-1") // idempotent within the session's copy
		assert.Equal(t, 249000.0, again.BalanceAfter)
		inv, _ := s.ListInvestments(ctx, "123")
		var names []string
		for _, i := range inv {
			names = append(names, i.Name)
		}
		assert.Equal(t, []string{"Checking", "Savings", "401K", "Vacation"}, names)
		c, _ := s.GetClient(ctx, "123")
		assert.Equal(t, "Doenut", c.LastName)
		return err
	})
	// The default session still sees the files.
	c, err := s.GetClient(context.Background(), "123")
	require.NoError(t, err)
	assert.Equal(t, "Doe", c.LastName)
}
