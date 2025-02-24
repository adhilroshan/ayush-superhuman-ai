# Use Node.js LTS version
FROM node:20-slim

# Set working directory
WORKDIR /ayush-superhuman-ai

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy all source files including frontend
COPY . .

# Create frontend directory if it doesn't exist
RUN mkdir -p frontend

RUN npm install -g ngrok

# Expose port 8080
EXPOSE 8080

# Start the application
CMD ["sh", "-c", "node index.js & ngrok http 8080 --domain assured-illegally-mink.ngrok-free.app"]