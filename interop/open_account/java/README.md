# Java open-account worker

Java `OpenInvestmentAccountWorkflow`, interchangeable with each port's native one. It calls the port's activities by name on `TEMPORAL_TASK_QUEUE`.

Source: `java/` from the reference port (copies from 2026-11-16 or later, which accept `USE_CLAIM_CHECK` = true, yes or 1). Gradle project, JDK 25: `./gradlew clean build`, `./gradlew test`, `./startlocalworker.sh <queue>`.
