FROM node:20-alpine

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY api/package*.json ./api/

# Install frontend dependencies
RUN npm ci || npm install

# Install backend dependencies
RUN cd api && npm ci || npm install

# Copy all source files
COPY . .

# Build frontend
RUN npm run build

# Expose port
EXPOSE 8080

# Start the server
CMD ["node", "api/server.js"]
