package io.temporal.demo.springai.common;

import io.temporal.activity.Activity;
import java.time.Duration;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Which browser session a chat, and everything it does, belongs to.
 *
 * <p>The API gives each browser a random session ID and starts its chat workflows with IDs that carry it:
 * {@code <framework's prefix>session-<32 hex chars>-chat-<16 hex chars>}. An open-account workflow's ID starts
 * with its chat's ID, so every activity finds the session from its workflow ID. Anything else uses the
 * {@value #DEFAULT} session. The session scopes the chaos flags and, with DEMO_DATA_STORE=redis, the sample
 * data. The Python, TypeScript and Go frameworks follow the same rules (src/python/common/session_scope.py).
 */
public final class Session {
    public static final String DEFAULT = "default";
    /** How long a session's state in Redis lives after its last change. */
    public static final Duration TTL = Duration.ofHours(24);
    private static final Pattern IN_WORKFLOW_ID = Pattern.compile("session-([0-9a-f]{32})-chat-");

    private Session() {
    }

    /** The session in a chat's or account opening's workflow ID, or the default session. */
    public static String fromWorkflowId(String workflowId) {
        if (workflowId == null) {
            return DEFAULT;
        }
        Matcher m = IN_WORKFLOW_ID.matcher(workflowId);
        return m.find() ? m.group(1) : DEFAULT;
    }

    /** The session of the workflow whose activity is running, or the default session outside an activity. */
    public static String current() {
        String workflowId = currentWorkflowId();
        return workflowId == null ? DEFAULT : fromWorkflowId(workflowId);
    }

    /** The running activity's workflow ID, or null outside an activity. */
    public static String currentWorkflowId() {
        try {
            return Activity.getExecutionContext().getInfo().getWorkflowId();
        } catch (RuntimeException notInAnActivity) {
            return null;
        }
    }
}
