# The TypeScript frameworks' Temporal workers (src/typescript: vercel_ai, google_adk, strands_agents, openai_agents),
# one image for the npm workspace. Each framework's worker is its own container, by its command:
#   npm run --workspace <framework> temporal:worker
# Built from the repository root. Configured only through the environment, as the other workers.
FROM node:26-slim
WORKDIR /app/src/typescript
# The workspace's manifests first, so the dependencies are a layer of their own
COPY src/typescript/package.json src/typescript/package-lock.json ./
COPY src/typescript/common/package.json common/
COPY src/typescript/vercel_ai/package.json vercel_ai/
COPY src/typescript/google_adk/package.json google_adk/
COPY src/typescript/strands_agents/package.json strands_agents/
COPY src/typescript/openai_agents/package.json openai_agents/
# With the dev dependencies: the workers run with ts-node
RUN npm ci --no-audit --no-fund
COPY src/typescript ./
COPY data /app/data
ENV NODE_ENV=production
USER node
CMD ["npm", "run", "--silent", "--workspace", "vercel_ai", "temporal:worker"]
