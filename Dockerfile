FROM node:20-alpine

# Install Chromium and dependencies for Puppeteer
RUN apk add --no-cache \
    chromium \
    nss \
    freetype \
    harfbuzz \
    ca-certificates \
    ttf-freefont

# Tell Puppeteer to use installed Chromium instead of downloading
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium-browser

WORKDIR /app

# Build arguments for Vite (needed at build time)
ARG VITE_SUPABASE_URL
ARG VITE_SUPABASE_ANON_KEY

# Set as environment variables so Vite can use them during build
ENV VITE_SUPABASE_URL=$VITE_SUPABASE_URL
ENV VITE_SUPABASE_ANON_KEY=$VITE_SUPABASE_ANON_KEY

# Copy package files
COPY package*.json ./
COPY api/package*.json ./api/

# Install frontend dependencies
RUN npm ci || npm install

# Install backend dependencies
RUN cd api && npm ci || npm install

# Copy all source files
COPY . .

# Build frontend (uses VITE_* env vars)
RUN npm run build

# Expose port
EXPOSE 8080

# Set working directory to api and start server
WORKDIR /app/api
CMD ["node", "server.js"]
