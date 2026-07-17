# Use a slim Node.js 18 image as the base
FROM node:18-bullseye-slim

# Install necessary system dependencies for the bot and yt-dlp
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-venv \
    curl \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install deno
RUN curl -fsSL https://deno.land/x/install/install.sh | sh
ENV PATH="/root/.deno/bin:$PATH"

# Set working directory
WORKDIR /app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install npm dependencies
RUN npm ci

# Create a virtual environment and install yt-dlp and its plugins
RUN python3 -m venv /opt/ytdlp-venv && \
    /opt/ytdlp-venv/bin/pip install -U yt-dlp[default] curl-cffi bgutil-ytdlp-pot-provider

# Ensure the python virtual environment is in the PATH so yt-dlp is accessible globally
ENV PATH="/opt/ytdlp-venv/bin:$PATH"

# Copy the rest of the application source code
COPY . .

# Start the bot
CMD ["npm", "start"]
