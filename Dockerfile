FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json server.js lobby.js engine.js index.html style.css app.js ai.js audio.js online.js ./
ENV NODE_ENV=production HOST=0.0.0.0 PORT=5173
USER node
EXPOSE 5173
HEALTHCHECK --interval=30s --timeout=3s CMD node -e "fetch('http://127.0.0.1:5173/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
