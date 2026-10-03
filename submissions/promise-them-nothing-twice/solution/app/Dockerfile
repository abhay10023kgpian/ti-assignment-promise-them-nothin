FROM node:20-alpine

# Create app directory
WORKDIR /app

# Install dependencies first (layer cached unless package.json changes)
COPY package.json ./
RUN npm install --omit=dev

# Copy source
COPY src/ ./src/

# Non-root user for security
RUN addgroup -S relay && adduser -S relay -G relay
USER relay

EXPOSE 3000

CMD ["node", "src/index.js"]
