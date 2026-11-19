package data_test

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/temporal-sa/adk-go-wealth-management/internal/data"
	"github.com/temporal-sa/adk-go-wealth-management/internal/domain"
	"github.com/temporal-sa/adk-go-wealth-management/internal/testfixtures"
)

func TestMoney(t *testing.T) {
	assert.Equal(t, "$1,234.50", data.Money(1234.5))
	assert.Equal(t, "$100.00", data.Money(100))
	assert.Equal(t, "$1,000,000.00", data.Money(1_000_000))
	assert.Equal(t, "$13,000.00", data.Money(13000))
	assert.Equal(t, "$0.07", data.Money(0.07))
}

func testStore(t *testing.T) *data.Store { return testfixtures.Store(t) }

func TestDemoData(t *testing.T) {
	s := testStore(t)
	c, err := s.GetClient("123")
	require.NoError(t, err)
	assert.Equal(t, "Don", c.FirstName)
	assert.Equal(t, "123 Main Street", c.Address)
	inv, err := s.ListInvestments("123")
	require.NoError(t, err)
	var names []string
	for _, i := range inv {
		names = append(names, i.Name)
	}
	assert.Equal(t, []string{"Checking", "Savings", "401K"}, names)
}

func TestTransfersAreIdempotent(t *testing.T) {
	s := testStore(t)
	first, err := s.Debit("123", 1000, "t-1")
	require.NoError(t, err)
	again, err := s.Debit("123", 1000, "t-1")
	require.NoError(t, err)
	assert.Equal(t, first, again)
	assert.Equal(t, 249000.0, again.BalanceAfter)

	_, err = s.Debit("123", 300000, "t-2")
	assert.True(t, errors.Is(err, data.ErrInsufficientFunds))
}

func TestBeneficiariesAndClients(t *testing.T) {
	s := testStore(t)
	rec, err := s.AddBeneficiary(domain.Beneficiary{ClientID: "123", FirstName: "Ann", LastName: "Doe", Relationship: "sister"})
	require.NoError(t, err)
	ok, err := s.DeleteBeneficiary("123", rec.BeneficiaryID)
	require.NoError(t, err)
	assert.True(t, ok)

	msg, err := s.UpdateClient("123", map[string]any{"last_name": "Doenut"})
	require.NoError(t, err)
	assert.Equal(t, "Client information successfully updated", msg)
	c, _ := s.GetClient("123")
	assert.Equal(t, "Doenut", c.LastName)
	assert.Equal(t, "Don", c.FirstName)
}
