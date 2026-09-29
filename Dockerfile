FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY kernel.mjs server.mjs cli.mjs test.mjs test-web.mjs ./
COPY plugins ./plugins
COPY sites ./sites
COPY public ./public
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "server.mjs"]
