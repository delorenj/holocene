# Holocene Dockerfile
# Multi-stage build: Vite → nginx

# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install pnpm
RUN npm install -g pnpm

# Install dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm run build

# Production stage - nginx
FROM nginx:alpine

# Copy built files from builder
COPY --from=builder /app/dist /usr/share/nginx/html

# Copy nginx configuration as template
COPY nginx.conf /etc/nginx/templates/default.conf.template

# Startup script: envsubst the Plane API key into nginx config, then start nginx
RUN printf '#!/bin/sh\n\
sed "s|PLANE_API_KEY_PLACEHOLDER|${PLANE_33GOD_API_KEY:-}|g" \
  /etc/nginx/templates/default.conf.template > /etc/nginx/conf.d/default.conf\n\
exec nginx -g "daemon off;"\n' > /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=30s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:80/health || exit 1

# Expose port
EXPOSE 80

# Start with envsubst then nginx
CMD ["/docker-entrypoint.sh"]
