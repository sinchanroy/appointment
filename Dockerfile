FROM node:18-slim

# Install dependencies for Puppeteer
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    libxss1 \
    libx11-6 \
    libxext6 \
    libxrender1 \
    libnss3 \
    libgconf-2-4 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy package files
COPY package*.json ./

# Install npm dependencies (includes Puppeteer which downloads Chromium)
RUN npm install --omit=dev

# Copy application
COPY app.js .

# Create data directory for state persistence
RUN mkdir -p /data && chmod 777 /data

# Run the application
CMD ["node", "app.js"]
