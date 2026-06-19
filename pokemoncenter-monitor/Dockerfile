# Apify's official Playwright + Chrome image (includes Node + browsers preinstalled)
FROM apify/actor-node-playwright-chrome:20

# Copy package files and install production dependencies
COPY --chown=myuser package*.json ./
RUN npm --quiet set progress=false \
    && npm install --omit=dev --no-optional \
    && echo "Installed NPM packages:" \
    && (npm list --omit=dev --all || true) \
    && echo "Node.js version:" \
    && node --version \
    && echo "NPM version:" \
    && npm --version

# Copy the rest of the source code
COPY --chown=myuser . ./

CMD ["node", "src/main.js"]
