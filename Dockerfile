# ---- Build Stage ----
FROM node:20-alpine AS build

# Install build tools for native modules (bcrypt)
RUN apk add --no-cache python3 make g++

WORKDIR /app

COPY package.json package-lock.json* ./

RUN npm ci

COPY . .

# ---- Production Stage ----
FROM node:20-alpine AS production

WORKDIR /app

ENV NODE_ENV=production

# Install build tools for native modules (bcrypt)
RUN apk add --no-cache python3 make g++

# Install only production dependencies
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev

# Remove build tools to reduce image size
RUN apk del python3 make g++

# Copy application code from build stage
COPY --from=build /app/src ./src

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

USER appuser

EXPOSE 3000

CMD ["node", "src/index.js"]
