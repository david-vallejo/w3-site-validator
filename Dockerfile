FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends default-jre-headless && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY validate-site.mjs server.mjs ./
EXPOSE 8321
CMD ["node", "server.mjs"]
