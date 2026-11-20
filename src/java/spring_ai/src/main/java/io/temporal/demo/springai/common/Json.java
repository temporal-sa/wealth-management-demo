package io.temporal.demo.springai.common;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.util.DefaultIndenter;
import com.fasterxml.jackson.core.util.DefaultPrettyPrinter;
import com.fasterxml.jackson.core.util.Separators;
import com.fasterxml.jackson.databind.DeserializationFeature;
import com.fasterxml.jackson.databind.ObjectMapper;

/** The JSON mapper, and pretty-printing in the style of Python's json.dump(..., indent=n). */
public final class Json {
    public static final ObjectMapper MAPPER = new ObjectMapper()
            .configure(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);

    private Json() {
    }

    /** Like Python's json.dumps(value, indent=n): "key": value, one item per line, {} and [] when empty. */
    public static String pretty(Object value, int indent) {
        DefaultIndenter indenter = new DefaultIndenter(" ".repeat(indent), "\n");
        Separators separators = Separators.createDefaultInstance()
                .withObjectFieldValueSpacing(Separators.Spacing.AFTER)
                .withObjectEmptySeparator("")
                .withArrayEmptySeparator("");
        DefaultPrettyPrinter printer = new DefaultPrettyPrinter(separators)
                .withObjectIndenter(indenter);
        printer.indentArraysWith(indenter);
        try {
            return MAPPER.writer(printer).writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }

    public static String compact(Object value) {
        try {
            return MAPPER.writeValueAsString(value);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
