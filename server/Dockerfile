FROM node:22-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY packages/workflow-contracts/package.json packages/workflow-contracts/package.json
COPY server/package.json server/package.json
RUN npm ci
COPY packages packages
COPY server server
RUN npm run prisma:generate -w @autoforge/server
CMD ["sh", "-c", "npm run prisma:migrate -w @autoforge/server && npm run seed -w @autoforge/server && npm run start -w @autoforge/server"]
