package io.temporal.demo.springai.common;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.text.DecimalFormat;
import java.text.DecimalFormatSymbols;
import java.util.Locale;

/** Dollar amounts as the other frameworks write them: {@code $1,234.50}. */
public final class Money {
    private Money() {
    }

    public static String format(double amount) {
        DecimalFormat f = new DecimalFormat("#,##0.00", DecimalFormatSymbols.getInstance(Locale.US));
        f.setRoundingMode(RoundingMode.HALF_UP);
        return (amount < 0 ? "-$" : "$") + f.format(Math.abs(amount));
    }

    /** Rounds to cents, as balances are stored. */
    public static double round2(double amount) {
        return BigDecimal.valueOf(amount).setScale(2, RoundingMode.HALF_UP).doubleValue();
    }
}
