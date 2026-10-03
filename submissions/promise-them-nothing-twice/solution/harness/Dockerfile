FROM node:20-alpine
WORKDIR /harness
COPY package.json ./
COPY harness.js   ./
USER node
CMD ["node", "harness.js"]
