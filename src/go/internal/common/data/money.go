package data

import (
	"fmt"
	"strings"
)

// Money formats an amount as dollars with thousands separators and two decimals,
// like Python's f"${amount:,.2f}": Money(1234.5) is "$1,234.50".
func Money(amount float64) string {
	sign := ""
	if amount < 0 {
		sign = "-"
		amount = -amount
	}
	s := fmt.Sprintf("%.2f", amount)
	whole, frac, _ := strings.Cut(s, ".")
	var b strings.Builder
	for i, c := range whole {
		if i > 0 && (len(whole)-i)%3 == 0 {
			b.WriteByte(',')
		}
		b.WriteRune(c)
	}
	return sign + "$" + b.String() + "." + frac
}
