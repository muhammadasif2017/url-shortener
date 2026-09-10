# Production image.
#
# Pinned to the same minor version as .nvmrc. The runtime type-stripping flag is
# experimental and version-sensitive, so "node:22-alpine" would be a silent way
# to change the language semantics of this service during a routine rebuild.
FROM node:22.15-alpine

WORKDIR /app

ENV NODE_ENV=production

# Dependencies first, as their own layer. Source changes far more often than
# package.json, so this layer stays cached across ordinary deploys.
COPY package.json package-lock.json ./

# --omit=dev keeps typescript and the type packages out of the image. Type
# checking belongs in CI, never at runtime: this project never emits JavaScript,
# so the compiler has no role in a running container.
# --ignore-scripts because no dependency here needs a build step, and a
# lifecycle script is a supply-chain foothold that costs nothing to close.
RUN npm ci --omit=dev --ignore-scripts

COPY migrations ./migrations
COPY scripts ./scripts
COPY src ./src

# The image ships the base `node` user. Running as root inside a container means
# a process escape starts with root, and nothing here needs the privilege.
USER node

EXPOSE 3000

# No curl or wget in this image, and adding one to run a health check would be a
# larger attack surface than the check is worth. Node is already here.
#
# /health/live, not /health. Docker's only response to an unhealthy container is
# to mark it, and an orchestrator reading that mark restarts it. A restart does
# not repair an unreachable database, so probing the database here would answer
# a database outage with a restart loop across every instance, at the moment the
# database is least able to absorb reconnections. Readiness is a question for a
# load balancer, and it has /health/ready for it.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health/live').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# --env-file-if-exists, not --env-file. There is no .env in this image: the
# platform injects variables into the process environment, and .env is
# gitignored so it will never be copied in. --env-file on a missing file is a
# hard crash before any code runs.
#
# Exec form, not shell form, so the process is PID 1 and receives SIGTERM
# directly. Under shell form the signal reaches /bin/sh instead, and the
# graceful shutdown sequence never runs.
CMD ["node", "--env-file-if-exists=.env", "--experimental-strip-types", "src/index.ts"]
