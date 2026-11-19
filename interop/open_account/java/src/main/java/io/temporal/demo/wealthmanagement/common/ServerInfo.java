package io.temporal.demo.wealthmanagement.common;

import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

public class ServerInfo {

    public static String getCertPath() {
        return getEnv("TEMPORAL_CERT_PATH", "");
    }

    public static String getKeyPath() {
        // check first for a specific pkcs8 env var, if null/empty then check for generic env var
        String keyPath = System.getenv("TEMPORAL_KEY_PKCS8_PATH");
        return keyPath != null && !keyPath.isEmpty() ? keyPath : getEnv("TEMPORAL_KEY_PATH", "");
    }

    public static String getNamespace() {
        return getEnv("TEMPORAL_NAMESPACE", "default");
    }

    public static String getAddress() {
        return getEnv("TEMPORAL_ADDRESS", "localhost:7233");
    }

    /**
     * The task queue of the port whose activities the open-account workflow calls
     * (TEMPORAL_TASK_QUEUE). There is no default: every port has its own queue, so the worker must
     * be told which port it serves.
     */
    public static String getTaskqueue() {
        String queue = System.getenv("TEMPORAL_TASK_QUEUE");
        if (queue == null || queue.isBlank()) {
            throw new IllegalStateException("TEMPORAL_TASK_QUEUE is not set. Set it to the task queue of the port"
                    + " whose account openings this worker runs, for example TEMPORAL_TASK_QUEUE=OAI-Supervisor"
                    + " (see interop/open_account/java/README.md).");
        }
        return queue.trim();
    }

    /** The task queue this worker runs the open-account workflow on (see {@link #openAccountTaskQueue}). */
    public static String getTaskqueueOpenAccount() {
        return openAccountTaskQueue(getTaskqueue(), System.getenv("TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT"));
    }

    /**
     * The open-account workflow's task queue: TEMPORAL_TASK_QUEUE_OPEN_ACCOUNT (value) if it names
     * one, otherwise the port's own {@code <task queue>-open-account}. The ports start the workflow
     * there when their worker script gets the argument {@code java}, so every port has its own
     * open-account queue and several ports can use Java workers at once.
     */
    static String openAccountTaskQueue(String taskQueue, String value) {
        if (value == null || value.isBlank() || value.trim().equalsIgnoreCase("java")) {
            return taskQueue + "-open-account";
        }
        return value.trim();
    }

    public static Boolean useClaimCheck() {
        return isTrue(getEnv("USE_CLAIM_CHECK", "false"));
    }

    /**
     * Whether a flag's value means on. Accepts the values the Python components' str_to_bool
     * accepts (true, t, yes, y or 1, in any case), so every component agrees on whether payloads
     * are claim-checked. Boolean.parseBoolean accepted only "true": with USE_CLAIM_CHECK=1 the
     * Python components claim-checked payloads this worker couldn't read.
     */
    static boolean isTrue(String value) {
        if (value == null) {
            return false;
        }
        return switch (value.trim().toLowerCase(Locale.ROOT)) {
            case "true", "t", "yes", "y", "1" -> true;
            default -> false;
        };
    }

    public static Map<String, String> getServerInfo() {
        Map<String, String> info = new HashMap<>();
        info.put("certPath", getCertPath());
        info.put("keyPath", getKeyPath());
        info.put("namespace", getNamespace());
        info.put("address", getAddress());
        info.put("taskQueue", getTaskqueue());
        info.put("useClaimCheck", useClaimCheck().toString());
        return info;
    }

    private static String getEnv(String key, String defaultValue) {
        String value = System.getenv(key);
        return value != null && !value.isEmpty() ? value : defaultValue;
    }
}
