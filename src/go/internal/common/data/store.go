// Package data manages the demo's system of record: the JSON files in data/
// (beneficiaries.json, clients.json, funding_accounts.json and investments.json).
//
// The files are tracked by git, so `git checkout data/` resets the demo.
package data

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
)

// Store reads and writes the JSON files in one data directory. Its methods are safe for
// concurrent use within one process.
type Store struct {
	dir string
	mu  sync.Mutex
}

// NewStore returns a Store for the given data directory.
func NewStore(dir string) *Store { return &Store{dir: dir} }

// Dir is the data directory.
func (s *Store) Dir() string { return s.dir }

// FindDataDir returns the data directory: DATA_DIR if it is set, otherwise the first
// data/ folder holding clients.json found in the working directory or above it.
func FindDataDir() (string, error) {
	if dir := os.Getenv("DATA_DIR"); dir != "" {
		return dir, nil
	}
	wd, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for dir := wd; ; dir = filepath.Dir(dir) {
		candidate := filepath.Join(dir, "data")
		if _, err := os.Stat(filepath.Join(candidate, "clients.json")); err == nil {
			return candidate, nil
		}
		if filepath.Dir(dir) == dir {
			return "", fmt.Errorf("no data/clients.json in %s or above it; set DATA_DIR", wd)
		}
	}
}

// ErrInsufficientFunds is returned by Debit when the linked account can't cover the transfer.
var ErrInsufficientFunds = errors.New("insufficient funds")

// ---------------------------------------------------------------------------
// Beneficiaries
// ---------------------------------------------------------------------------

// ListBeneficiaries returns a client's beneficiaries (an empty list if there are none).
func (s *Store) ListBeneficiaries(clientID string) ([]domain.BeneficiaryRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := map[string][]domain.BeneficiaryRecord{}
	if err := s.load("beneficiaries.json", &data); err != nil {
		return nil, err
	}
	list := data[clientID]
	if list == nil {
		list = []domain.BeneficiaryRecord{}
	}
	return list, nil
}

// AddBeneficiary adds a beneficiary to a client, with a new unique ID.
func (s *Store) AddBeneficiary(b domain.Beneficiary) (domain.BeneficiaryRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := map[string][]domain.BeneficiaryRecord{}
	if err := s.load("beneficiaries.json", &data); err != nil {
		return domain.BeneficiaryRecord{}, err
	}
	existing := map[string]bool{}
	for _, r := range data[b.ClientID] {
		existing[r.BeneficiaryID] = true
	}
	id := newID("b-")
	for existing[id] {
		id = newID("b-")
	}
	rec := domain.BeneficiaryRecord{BeneficiaryID: id, FirstName: b.FirstName, LastName: b.LastName, Relationship: b.Relationship}
	data[b.ClientID] = append(data[b.ClientID], rec)
	return rec, s.save("beneficiaries.json", data, 4)
}

// DeleteBeneficiary removes a client's beneficiary by ID. It reports whether one was removed.
func (s *Store) DeleteBeneficiary(clientID, beneficiaryID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := map[string][]domain.BeneficiaryRecord{}
	if err := s.load("beneficiaries.json", &data); err != nil {
		return false, err
	}
	kept := []domain.BeneficiaryRecord{}
	for _, r := range data[clientID] {
		if r.BeneficiaryID != beneficiaryID {
			kept = append(kept, r)
		}
	}
	if len(kept) == len(data[clientID]) {
		return false, nil
	}
	data[clientID] = kept
	return true, s.save("beneficiaries.json", data, 4)
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

// GetClient returns a client's details, or nil if there is no such client.
func (s *Store) GetClient(clientID string) (*domain.WealthManagementClient, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := map[string]domain.WealthManagementClient{}
	if err := s.load("clients.json", &data); err != nil {
		return nil, err
	}
	c, ok := data[clientID]
	if !ok {
		return nil, nil
	}
	return &c, nil
}

// UpdateClient changes the given fields of a client's details and returns a message
// saying what happened, as the other ports do.
func (s *Store) UpdateClient(clientID string, fields map[string]any) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := map[string]domain.WealthManagementClient{}
	if err := s.load("clients.json", &data); err != nil {
		return "", err
	}
	c, ok := data[clientID]
	if !ok {
		return fmt.Sprintf("Client %s not found", clientID), nil
	}
	for name, value := range fields {
		if value == nil {
			continue
		}
		c.SetField(name, fmt.Sprint(value))
	}
	data[clientID] = c
	if err := s.save("clients.json", data, 4); err != nil {
		return "", err
	}
	return "Client information successfully updated", nil
}

// ---------------------------------------------------------------------------
// Investments
// ---------------------------------------------------------------------------

// ListInvestments returns a client's investment accounts (an empty list if there are none).
func (s *Store) ListInvestments(clientID string) ([]domain.InvestmentRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := map[string][]domain.InvestmentRecord{}
	if err := s.load("investments.json", &data); err != nil {
		return nil, err
	}
	list := data[clientID]
	if list == nil {
		list = []domain.InvestmentRecord{}
	}
	return list, nil
}

// AddInvestment adds an investment account to a client, with a new unique ID.
func (s *Store) AddInvestment(a domain.InvestmentAccount) (domain.InvestmentRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if a.Balance < 0 {
		return domain.InvestmentRecord{}, fmt.Errorf("balance must not be negative")
	}
	data := map[string][]domain.InvestmentRecord{}
	if err := s.load("investments.json", &data); err != nil {
		return domain.InvestmentRecord{}, err
	}
	existing := map[string]bool{}
	for _, r := range data[a.ClientID] {
		existing[r.InvestmentID] = true
	}
	id := newID("i-")
	for existing[id] {
		id = newID("i-")
	}
	rec := domain.InvestmentRecord{InvestmentID: id, Name: a.Name, Balance: a.Balance}
	data[a.ClientID] = append(data[a.ClientID], rec)
	return rec, s.save("investments.json", data, 2)
}

// DeleteInvestment removes a client's investment account by ID. It reports whether one was removed.
func (s *Store) DeleteInvestment(clientID, investmentID string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	data := map[string][]domain.InvestmentRecord{}
	if err := s.load("investments.json", &data); err != nil {
		return false, err
	}
	kept := []domain.InvestmentRecord{}
	for _, r := range data[clientID] {
		if r.InvestmentID != investmentID {
			kept = append(kept, r)
		}
	}
	if len(kept) == len(data[clientID]) {
		return false, nil
	}
	if len(kept) == 0 {
		delete(data, clientID)
	} else {
		data[clientID] = kept
	}
	return true, s.save("investments.json", data, 2)
}

// ---------------------------------------------------------------------------
// Funding: the client's linked external bank account
// ---------------------------------------------------------------------------

type fundingAccount struct {
	Name    string  `json:"name"`
	Balance float64 `json:"balance"`
}

type fundingData struct {
	Accounts  map[string]*fundingAccount  `json:"accounts"`
	Transfers map[string]*domain.Transfer `json:"transfers"`
}

// Debit takes money from a client's linked bank account. The transfer ID makes it
// idempotent: applying the same transfer again returns the first result and moves no money.
func (s *Store) Debit(clientID string, amount float64, transferID string) (domain.Transfer, error) {
	return s.applyTransfer(clientID, -amount, transferID)
}

// Credit returns money to a client's linked bank account, idempotently (see Debit).
func (s *Store) Credit(clientID string, amount float64, transferID string) (domain.Transfer, error) {
	return s.applyTransfer(clientID, amount, transferID)
}

func (s *Store) applyTransfer(clientID string, delta float64, transferID string) (domain.Transfer, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var data fundingData
	if err := s.load("funding_accounts.json", &data); err != nil {
		return domain.Transfer{}, err
	}
	if data.Transfers == nil {
		data.Transfers = map[string]*domain.Transfer{}
	}
	if t, ok := data.Transfers[transferID]; ok {
		return *t, nil
	}
	account := data.Accounts[clientID]
	if account == nil {
		return domain.Transfer{}, fmt.Errorf("no linked funding account for client %s", clientID)
	}
	if delta < 0 && account.Balance < -delta {
		return domain.Transfer{}, fmt.Errorf("%w: %s has %s, which is not enough to transfer %s",
			ErrInsufficientFunds, account.Name, Money(account.Balance), Money(-delta))
	}
	account.Balance = round2(account.Balance + delta)
	t := &domain.Transfer{ClientID: clientID, Amount: delta, BalanceAfter: account.Balance}
	data.Transfers[transferID] = t
	return *t, s.save("funding_accounts.json", data, 2)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

func (s *Store) load(name string, v any) error {
	b, err := os.ReadFile(filepath.Join(s.dir, name))
	if errors.Is(err, os.ErrNotExist) || (err == nil && len(b) == 0) {
		return nil
	}
	if err != nil {
		return err
	}
	return json.Unmarshal(b, v)
}

func (s *Store) save(name string, v any, indent int) error {
	b, err := json.MarshalIndent(v, "", spaces(indent))
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(s.dir, name), b, 0o644)
}

func spaces(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = ' '
	}
	return string(b)
}

func newID(prefix string) string {
	b := make([]byte, 4)
	_, _ = rand.Read(b)
	return prefix + hex.EncodeToString(b)
}

func round2(f float64) float64 {
	if f < 0 {
		return -round2(-f)
	}
	return float64(int64(f*100+0.5)) / 100
}
