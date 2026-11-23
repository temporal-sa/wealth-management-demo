# The Spring AI framework's Temporal worker (src/java/spring_ai), as Spring Boot's executable jar. Built from the
# repository root. Configured only through the environment, as the other workers (Redis from REDIS_HOST, REDIS_PORT
# and REDIS_PASSWORD).
FROM eclipse-temurin:25-jdk AS build
WORKDIR /src
COPY src/java/spring_ai ./
# bootJar is the executable jar; Gradle's jar task also writes a -plain.jar without the dependencies
RUN ./gradlew --no-daemon -q bootJar && cp "$(ls build/libs/*.jar | grep -v -- '-plain.jar')" /out.jar

FROM eclipse-temurin:25-jre
COPY --from=build /out.jar /app/worker.jar
COPY data /app/data
ENV DATA_DIR=/app/data
RUN useradd --uid 10001 --no-create-home app
USER 10001
CMD ["java", "-jar", "/app/worker.jar"]
