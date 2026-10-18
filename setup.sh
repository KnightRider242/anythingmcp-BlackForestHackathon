#!/usr/bin/env bash
# =============================================================================
# AnythingMCP + CODEBOUND — Interactive Setup Script
# =============================================================================
# Generates .env, configures services, and sets up the integrated application.
# On local mode, CODEBOUND scripts execute in isolated Docker Linux containers.
# Works on macOS and Linux. Requires bash, Docker Linux containers, Node 22.12+, npm.
# =============================================================================

set -euo pipefail

# Run from the repository regardless of the caller's current directory.
ROOT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"
case "${1:-}" in
  --help|-h)
    cat <<'USAGE'
Usage:
  bash setup.sh                 Interactive first-time installation
  bash setup.sh --add-codebound  Preserve the existing .env/database and add
                                 the CODEBOUND sandbox to a local development setup

Choose "Local development + CODEBOUND" for executable workflows. The existing
single-container Docker Compose deployment does not provide a trusted Docker
supervisor; its CODEBOUND script execution is unavailable.
USAGE
    exit 0 ;;
  --add-codebound)
    bash scripts/setup-codebound.sh --existing
    exit $? ;;
  "") ;;
  *) printf 'Unknown option: %s (run bash setup.sh --help)\n' "$1" >&2; exit 2 ;;
esac

# ── Colors ───────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
DIM='\033[2m'
NC='\033[0m'

# ── Helpers ──────────────────────────────────────────────────────────────────

info()    { echo -e "${BLUE}$*${NC}"; }
success() { echo -e "${GREEN}$*${NC}"; }
warn()    { echo -e "${YELLOW}$*${NC}"; }
error()   { echo -e "${RED}$*${NC}" >&2; }

ask() {
  local prompt="$1" default="$2"
  local value
  if [ -n "$default" ]; then
    read -rp "$(echo -e "${BOLD}$prompt${NC} ${DIM}[$default]${NC}: ")" value
    echo "${value:-$default}"
  else
    read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" value
    echo "$value"
  fi
}

ask_yn() {
  local prompt="$1" default="${2:-n}"
  local hint
  if [[ "$default" =~ ^[Yy] ]]; then hint="Y/n"; else hint="y/N"; fi
  local value
  read -rp "$(echo -e "${BOLD}$prompt${NC} ${DIM}[$hint]${NC}: ")" value
  value="${value:-$default}"
  [[ "$value" =~ ^[Yy] ]]
}

ask_choice() {
  local prompt="$1"
  shift
  local options=("$@")
  local i=1
  echo "" >&2
  for opt in "${options[@]}"; do
    echo -e "  ${BOLD}$i)${NC} $opt" >&2
    i=$((i + 1))
  done
  echo "" >&2
  local choice
  read -rp "$(echo -e "${BOLD}$prompt${NC}: ")" choice
  echo "$choice"
}

generate_secret() {
  local bytes="${1:-32}"
  openssl rand -hex "$bytes" 2>/dev/null \
    || LC_ALL=C tr -dc 'a-f0-9' < /dev/urandom | head -c "$((bytes * 2))"
}

generate_key_32() {
  # Exactly 32 characters (ASCII) for AES-256 key
  openssl rand -base64 32 2>/dev/null | head -c 32 \
    || LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32
}

wait_for_health() {
  local url="$1" max_wait="${2:-120}" elapsed=0
  echo -ne "  Waiting for services to start"
  while [ $elapsed -lt "$max_wait" ]; do
    if curl -sf "$url" > /dev/null 2>&1; then
      echo -e " ${GREEN}ready!${NC}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    echo -n "."
  done
  echo -e " ${RED}timeout after ${max_wait}s${NC}"
  return 1
}

wait_for_postgres() {
  local host="$1" port="$2" max_wait="${3:-60}" elapsed=0
  echo -ne "  Waiting for PostgreSQL"
  while [ $elapsed -lt "$max_wait" ]; do
    if pg_isready -h "$host" -p "$port" > /dev/null 2>&1; then
      echo -e " ${GREEN}ready!${NC}"
      return 0
    fi
    # Fallback: try TCP connection
    if (echo > /dev/tcp/"$host"/"$port") 2>/dev/null; then
      sleep 1
      echo -e " ${GREEN}ready!${NC}"
      return 0
    fi
    sleep 2
    elapsed=$((elapsed + 2))
    echo -n "."
  done
  echo -e " ${RED}timeout after ${max_wait}s${NC}"
  return 1
}

# ── Main ─────────────────────────────────────────────────────────────────────

main() {
  echo ""
  echo -e "${BOLD}==================================${NC}"
  echo -e "${BOLD}  AnythingMCP + CODEBOUND Setup${NC}"
  echo -e "${BOLD}==================================${NC}"
  echo -e "${DIM}  This script will configure AnythingMCP and its CODEBOUND features.${NC}"
  echo ""

  # Check for existing .env
  if [ -f .env ]; then
    warn "An existing .env file was found."
    if ! ask_yn "Overwrite it?" "n"; then
      info "Setup cancelled. For a safe CODEBOUND upgrade, use: bash setup.sh --add-codebound"
      exit 0
    fi
    echo ""
  fi

  # ── Step 1: Deployment Mode ──────────────────────────────────────────────
  info "Step 1: Deployment Mode"
  local mode_choice
  mode_choice=$(ask_choice "Choose mode" \
    "Docker (AnythingMCP; CODEBOUND execution requires a separate supervisor)" \
    "Local development + CODEBOUND (recommended; requires Node.js 22.12+)")

  local MODE
  case "$mode_choice" in
    1) MODE="docker" ;;
    2) MODE="local" ;;
    *) MODE="docker" ;;
  esac

  # Docker-only app bundles the CODEBOUND UI/routes but cannot reach a trusted
  # host Docker supervisor. Never mount /var/run/docker.sock into the web app.
  if [ "$MODE" = "docker" ]; then
    warn "Docker-only mode does NOT execute CODEBOUND scripts: no trusted sandbox supervisor is configured."
    if ! ask_yn "Continue with the standard AnythingMCP Docker deployment anyway?" "n"; then
      info "Choose local development mode for working CODEBOUND execution."
      exit 0
    fi
  fi

  # Check prerequisites
  if [ "$MODE" = "docker" ]; then
    if ! command -v docker &> /dev/null; then
      error "Docker is not installed. Please install Docker first: https://docs.docker.com/get-docker/"
      exit 1
    fi
    if ! docker compose version &> /dev/null; then
      error "Docker Compose is not available. Please update Docker or install docker-compose."
      exit 1
    fi
  else
    for executable in docker node npm; do
      if ! command -v "$executable" &>/dev/null; then
        error "$executable is required for the integrated local CODEBOUND setup."
        exit 1
      fi
    done
    if ! docker compose version &>/dev/null || ! docker info &>/dev/null; then
      error "Docker with Compose v2 must be running (Linux containers)."
      exit 1
    fi
    if [ "$(docker info --format '{{.OSType}}')" != linux ]; then
      error "CODEBOUND requires Docker Linux containers."
      exit 1
    fi
    if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=12)?0:1)'; then
      error "Node.js 22.12+ is required for integrated CODEBOUND setup."
      exit 1
    fi
  fi
  for executable in openssl curl; do
    if ! command -v "$executable" &>/dev/null; then
      error "$executable is required for initial setup."
      exit 1
    fi
  done

  # ── Step 2: Domain & Ports ───────────────────────────────────────────────
  echo ""
  info "Step 2: Domain & Ports"

  local HOSTNAME FRONTEND_PORT BACKEND_PORT PROTOCOL
  local CADDY_ENABLED="false" ACME_EMAIL="" DOMAIN="" APP_BIND_IP="0.0.0.0"

  HOSTNAME=$(ask "Hostname or domain" "localhost")

  if [ "$HOSTNAME" = "localhost" ] || [ "$HOSTNAME" = "127.0.0.1" ]; then
    PROTOCOL="http"
    FRONTEND_PORT=$(ask "Frontend port" "3000")
    BACKEND_PORT=$(ask "Backend port" "4000")
  else
    if ask_yn "Enable HTTPS with automatic SSL certificate? (recommended)" "y"; then
      PROTOCOL="https"
      CADDY_ENABLED="true"
      DOMAIN="$HOSTNAME"
      ACME_EMAIL=$(ask "Email for Let's Encrypt notifications" "")
      APP_BIND_IP="127.0.0.1"
      # Standard ports — Caddy handles 80/443, routes to app internally
      FRONTEND_PORT="3000"
      BACKEND_PORT="4000"
      echo ""
      success "  Caddy reverse proxy will handle SSL and routing."
      success "  App ports (3000/4000) will only be accessible from the server."
    else
      PROTOCOL="http"
      FRONTEND_PORT=$(ask "Frontend port" "3000")
      BACKEND_PORT=$(ask "Backend port" "4000")
    fi
  fi

  # Build URLs
  local FRONTEND_URL BACKEND_URL
  if [ "$CADDY_ENABLED" = "true" ]; then
    # Caddy: single domain, standard ports, same URL for frontend & backend
    FRONTEND_URL="https://$HOSTNAME"
    BACKEND_URL="https://$HOSTNAME"
  elif [ "$PROTOCOL" = "https" ]; then
    if [ "$FRONTEND_PORT" = "443" ]; then
      FRONTEND_URL="https://$HOSTNAME"
    else
      FRONTEND_URL="https://$HOSTNAME:$FRONTEND_PORT"
    fi
    if [ "$BACKEND_PORT" = "443" ]; then
      BACKEND_URL="https://$HOSTNAME"
    else
      BACKEND_URL="https://$HOSTNAME:$BACKEND_PORT"
    fi
  else
    if [ "$FRONTEND_PORT" = "80" ]; then
      FRONTEND_URL="http://$HOSTNAME"
    else
      FRONTEND_URL="http://$HOSTNAME:$FRONTEND_PORT"
    fi
    if [ "$BACKEND_PORT" = "80" ]; then
      BACKEND_URL="http://$HOSTNAME"
    else
      BACKEND_URL="http://$HOSTNAME:$BACKEND_PORT"
    fi
  fi

  # ── Step 3: Secrets ──────────────────────────────────────────────────────
  echo ""
  info "Step 3: Generating Secrets"

  local JWT_SECRET ENCRYPTION_KEY NEXTAUTH_SECRET POSTGRES_PASSWORD

  JWT_SECRET=$(generate_secret 32)
  ENCRYPTION_KEY=$(generate_key_32)
  NEXTAUTH_SECRET=$(generate_secret 32)
  POSTGRES_PASSWORD=$(generate_secret 16)

  success "  JWT_SECRET:       generated (64-char hex)"
  success "  ENCRYPTION_KEY:   generated (32-char)"
  success "  NEXTAUTH_SECRET:  generated (64-char hex)"
  success "  POSTGRES_PASSWORD: generated (32-char hex)"

  # ── Step 4: MCP Authentication ───────────────────────────────────────────
  echo ""
  info "Step 4: MCP Authentication"

  local auth_choice MCP_AUTH_MODE MCP_BEARER_TOKEN="" MCP_API_KEY=""
  auth_choice=$(ask_choice "Authentication mode for MCP endpoint" \
    "OAuth 2.0 (recommended)" \
    "API Key / Bearer Token (legacy)" \
    "Both (OAuth + legacy fallback)" \
    "None (development only)")

  case "$auth_choice" in
    1) MCP_AUTH_MODE="oauth2" ;;
    2) MCP_AUTH_MODE="legacy" ;;
    3) MCP_AUTH_MODE="both" ;;
    4) MCP_AUTH_MODE="none" ;;
    *) MCP_AUTH_MODE="oauth2" ;;
  esac

  if [ "$MCP_AUTH_MODE" = "legacy" ] || [ "$MCP_AUTH_MODE" = "both" ]; then
    echo ""
    if ask_yn "Auto-generate legacy MCP tokens?" "y"; then
      MCP_BEARER_TOKEN=$(generate_secret 32)
      MCP_API_KEY=$(generate_secret 32)
      success "  MCP_BEARER_TOKEN: generated"
      success "  MCP_API_KEY:      generated"
    else
      MCP_BEARER_TOKEN=$(ask "MCP Bearer Token" "")
      MCP_API_KEY=$(ask "MCP API Key" "")
    fi
  fi

  # ── Step 5: Email / SMTP ─────────────────────────────────────────────────
  echo ""
  info "Step 5: Email Configuration"

  local SMTP_HOST="" SMTP_PORT="" SMTP_USER="" SMTP_PASS="" SMTP_FROM="" SMTP_FROM_NAME="" EMAIL_CONFIGURED="No"

  if ask_yn "Configure SMTP email (for verification, invites, password reset)?" "n"; then
    EMAIL_CONFIGURED="Yes"
    SMTP_HOST=$(ask "SMTP Host" "smtp.gmail.com")
    SMTP_PORT=$(ask "SMTP Port" "587")
    SMTP_USER=$(ask "SMTP User" "")
    SMTP_PASS=$(ask "SMTP Password" "")
    SMTP_FROM=$(ask "Sender email" "noreply@example.com")
    SMTP_FROM_NAME=$(ask "Sender name" "AnythingMCP")
  fi

  # ── Step 6: Redis ────────────────────────────────────────────────────────
  echo ""
  info "Step 6: Redis (Optional)"

  local REDIS_ENABLED="false" REDIS_URL=""
  if ask_yn "Enable Redis for rate limiting and caching?" "n"; then
    REDIS_ENABLED="true"
    if [ "$MODE" = "docker" ]; then
      REDIS_URL="redis://redis:6379"
    else
      REDIS_URL=$(ask "Redis URL" "redis://localhost:6379")
    fi
  fi

  # ── Step 7: PostgreSQL port (local dev only) ─────────────────────────────
  local POSTGRES_PORT="5432"
  local POSTGRES_HOST="postgres"
  local DATABASE_URL

  if [ "$MODE" = "local" ]; then
    echo ""
    info "Step 7: PostgreSQL"
    POSTGRES_PORT=$(ask "PostgreSQL external port" "5433")
    POSTGRES_HOST="localhost"
    DATABASE_URL="postgresql://amcp:${POSTGRES_PASSWORD}@localhost:${POSTGRES_PORT}/anythingmcp"
  else
    DATABASE_URL="postgresql://amcp:${POSTGRES_PASSWORD}@postgres:5432/anythingmcp"
  fi

  # ── Summary ──────────────────────────────────────────────────────────────
  echo ""
  echo -e "${BOLD}==================================${NC}"
  echo -e "${BOLD}  Configuration Summary${NC}"
  echo -e "${BOLD}==================================${NC}"
  echo -e "  Mode:         ${BOLD}$([ "$MODE" = "docker" ] && echo "Docker (production)" || echo "Local development")${NC}"
  echo -e "  Frontend:     ${BOLD}$FRONTEND_URL${NC}"
  echo -e "  Backend:      ${BOLD}$BACKEND_URL${NC}"
  echo -e "  MCP Endpoint: ${BOLD}$BACKEND_URL/mcp${NC}"
  if [ "$CADDY_ENABLED" = "true" ]; then
    echo -e "  SSL:          ${BOLD}Caddy (automatic Let's Encrypt)${NC}"
  fi
  echo -e "  MCP Auth:     ${BOLD}$MCP_AUTH_MODE${NC}"
  echo -e "  Email:        ${BOLD}$EMAIL_CONFIGURED${NC}"
  echo -e "  Redis:        ${BOLD}$([ "$REDIS_ENABLED" = "true" ] && echo "Enabled" || echo "Disabled")${NC}"
  if [ "$MODE" = "local" ]; then
    echo -e "  PostgreSQL:   ${BOLD}localhost:$POSTGRES_PORT${NC}"
  fi
  echo ""

  if ! ask_yn "Proceed with setup?" "y"; then
    info "Setup cancelled."
    exit 0
  fi

  # ── Write .env ───────────────────────────────────────────────────────────
  echo ""
  info "Writing .env file..."

  local NODE_ENV
  if [ "$MODE" = "docker" ]; then
    NODE_ENV="production"
  else
    NODE_ENV="development"
  fi

  cat > .env << ENVEOF
# =============================================================================
# AnythingMCP — Environment Variables (generated by setup.sh)
# =============================================================================

# ── General ──────────────────────────────────────────────────────────────────
NODE_ENV=$NODE_ENV
PORT=$BACKEND_PORT

# ── Database ─────────────────────────────────────────────────────────────────
POSTGRES_PASSWORD=$POSTGRES_PASSWORD
DATABASE_URL=$DATABASE_URL

# ── Redis (optional) ─────────────────────────────────────────────────────────
$([ -n "$REDIS_URL" ] && echo "REDIS_URL=$REDIS_URL" || echo "# REDIS_URL=redis://redis:6379")

# ── Security ─────────────────────────────────────────────────────────────────
JWT_SECRET=$JWT_SECRET
ENCRYPTION_KEY=$ENCRYPTION_KEY

# ── Frontend ─────────────────────────────────────────────────────────────────
FRONTEND_URL=$FRONTEND_URL
NEXT_PUBLIC_API_URL=$BACKEND_URL
NEXTAUTH_URL=$FRONTEND_URL
NEXTAUTH_SECRET=$NEXTAUTH_SECRET
# Host-run frontend proxy uses the same integrated NestJS backend.
BACKEND_INTERNAL_URL=http://127.0.0.1:$BACKEND_PORT

# ── CORS ─────────────────────────────────────────────────────────────────────
CORS_ORIGIN=$FRONTEND_URL

# ── MCP Server Auth ──────────────────────────────────────────────────────────
MCP_AUTH_MODE=$MCP_AUTH_MODE
$([ -n "$MCP_BEARER_TOKEN" ] && echo "MCP_BEARER_TOKEN=$MCP_BEARER_TOKEN" || echo "# MCP_BEARER_TOKEN=")
$([ -n "$MCP_API_KEY" ] && echo "MCP_API_KEY=$MCP_API_KEY" || echo "# MCP_API_KEY=")
SERVER_URL=$BACKEND_URL

# ── MCP Rate Limiting ────────────────────────────────────────────────────────
MCP_RATE_LIMIT_PER_MINUTE=60

# ── Email / SMTP ─────────────────────────────────────────────────────────────
$(if [ "$EMAIL_CONFIGURED" = "Yes" ]; then
cat << SMTPEOF
SMTP_HOST=$SMTP_HOST
SMTP_PORT=$SMTP_PORT
SMTP_USER=$SMTP_USER
SMTP_PASS=$SMTP_PASS
SMTP_FROM=$SMTP_FROM
SMTP_FROM_NAME=$SMTP_FROM_NAME
SMTPEOF
else
echo "# SMTP_HOST="
echo "# SMTP_PORT="
echo "# SMTP_USER="
echo "# SMTP_PASS="
echo "# SMTP_FROM="
echo "# SMTP_FROM_NAME="
fi)

# ── Ports (Docker) ───────────────────────────────────────────────────────────
FRONTEND_PORT=$FRONTEND_PORT
BACKEND_PORT=$BACKEND_PORT
# Docker installations build this fork; do not replace upstream's latest tag.
ANYTHINGMCP_IMAGE=codebound-anythingmcp:local
$([ "$MODE" = "local" ] && echo "POSTGRES_PORT=$POSTGRES_PORT" || echo "# POSTGRES_PORT=5433")

# ── Reverse Proxy (Caddy) ───────────────────────────────────────────────────
$(if [ "$CADDY_ENABLED" = "true" ]; then
cat << CADDYENVEOF
COMPOSE_PROFILES=proxy
DOMAIN=$DOMAIN
ACME_EMAIL=$ACME_EMAIL
APP_BIND_IP=$APP_BIND_IP
CADDYENVEOF
else
echo "# COMPOSE_PROFILES=proxy"
echo "# DOMAIN="
echo "# ACME_EMAIL="
echo "# APP_BIND_IP=0.0.0.0"
fi)
ENVEOF

  chmod 600 .env
  success "  .env file created with owner-only permissions."

  # ── Execute Setup ────────────────────────────────────────────────────────
  if [ "$MODE" = "docker" ]; then
    # --- Docker Mode ---
    echo ""
    info "Starting Docker services..."

    # Generate Caddyfile if Caddy reverse proxy is enabled
    if [ "$CADDY_ENABLED" = "true" ]; then
      cat > Caddyfile << CADDYEOF
$DOMAIN {
    tls $ACME_EMAIL

    # Backend API, MCP, OAuth2, health
    reverse_proxy /api/*          app:4000
    reverse_proxy /mcp/*          app:4000
    reverse_proxy /health/*       app:4000
    reverse_proxy /.well-known/*  app:4000
    reverse_proxy /authorize      app:4000
    reverse_proxy /token          app:4000
    reverse_proxy /register       app:4000
    reverse_proxy /callback       app:4000
    reverse_proxy /revoke         app:4000
    reverse_proxy /auth/*         app:4000

    # Frontend (catch-all)
    reverse_proxy app:3000
}
CADDYEOF
      success "  Caddyfile created (SSL for $DOMAIN)."
    fi

    # Generate docker-compose.override.yml for Redis if enabled
    if [ "$REDIS_ENABLED" = "true" ]; then
      cat > docker-compose.override.yml << 'REDISEOF'
# Generated by setup.sh — Redis enabled
services:
  app:
    environment:
      - REDIS_URL=redis://redis:6379
    depends_on:
      redis:
        condition: service_healthy

  redis:
    image: redis:7-alpine
    container_name: amcp-redis
    volumes:
      - redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  redis_data:
REDISEOF
      success "  docker-compose.override.yml created (Redis enabled)."
    else
      # Remove override if it exists from a previous run
      rm -f docker-compose.override.yml
    fi

    # Preserve existing database volumes and credentials. An existing Docker
    # installation should reuse its original .env rather than regenerate it.
    # This installer intentionally never runs 'docker compose down -v'.

    echo ""
    info "Building and starting containers (this may take a few minutes on first run)..."
    echo ""

    docker compose up -d --build

    echo ""
    if wait_for_health "http://localhost:${BACKEND_PORT}/health" 180; then
      echo ""
      echo -e "${GREEN}${BOLD}==================================${NC}"
      echo -e "${GREEN}${BOLD}  AnythingMCP is running!${NC}"
      echo -e "${GREEN}${BOLD}==================================${NC}"
      echo ""
      echo -e "  Web UI:        ${BOLD}$FRONTEND_URL${NC}"
      echo -e "  Backend API:   ${BOLD}$BACKEND_URL${NC}"
      echo -e "  MCP Endpoint:  ${BOLD}$BACKEND_URL/mcp${NC}"
      echo -e "  Swagger Docs:  ${BOLD}$BACKEND_URL/api/docs${NC}"
      echo ""
      warn "CODEBOUND script execution is unavailable in Docker-only mode without a separate trusted supervisor."
      echo -e "  ${DIM}Next step: Open ${FRONTEND_URL} and register your admin account.${NC}"
      echo -e "  ${DIM}The first user to register will become the administrator.${NC}"
      echo ""
    else
      warn "Services did not become healthy in time."
      warn "Check logs with: docker compose logs -f"
    fi

  else
    # --- Local Development Mode ---
    echo ""
    info "Setting up local development environment..."

    # The CODEBOUND dev launcher propagates the root .env to both workspaces.
    # Do not overwrite preexisting package-specific .env files or symlinks.
    info "  Using root .env through npm run codebound:dev (no package files overwritten)."

    # Start PostgreSQL via Docker
    echo ""
    info "Starting PostgreSQL via Docker..."

    # Never reset a database volume during installation. Safe incremental
    # CODEBOUND migrations run against the existing configured database.

    docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres

    echo ""
    if wait_for_postgres "localhost" "$POSTGRES_PORT" 60; then
      :
    else
      warn "PostgreSQL did not start in time. Check: docker compose logs postgres"
    fi

    # Install dependencies
    echo ""
    info "Installing npm dependencies..."
    npm ci

    # CODEBOUND is part of the same NestJS/Next.js application. Prepare its
    # restricted Docker runner and apply all existing additive migrations.
    echo ""
    info "Installing CODEBOUND in the existing application..."
    bash scripts/setup-codebound.sh --existing
    success "  CODEBOUND sandbox and database migrations prepared."

    echo ""
    echo -e "${GREEN}${BOLD}==================================${NC}"
    echo -e "${GREEN}${BOLD}  Setup Complete!${NC}"
    echo -e "${GREEN}${BOLD}==================================${NC}"
    echo ""
    echo -e "  PostgreSQL:    ${BOLD}localhost:$POSTGRES_PORT${NC}"
    echo ""
    echo -e "  To start the development servers, run:"
    echo ""
    echo -e "    ${BOLD}npm run codebound:dev${NC}"
    echo ""
    echo -e "  Then open:"
    echo -e "    Web UI:        ${BOLD}$FRONTEND_URL${NC}"
    echo -e "    Backend API:   ${BOLD}$BACKEND_URL${NC}"
    echo -e "    MCP Endpoint:  ${BOLD}$BACKEND_URL/mcp${NC}"
    echo -e "    Swagger Docs:  ${BOLD}$BACKEND_URL/api/docs${NC}"
    echo -e "    CODEBOUND:      ${BOLD}$FRONTEND_URL/scripts${NC}"
    echo -e "    Run history:    ${BOLD}$FRONTEND_URL/scripts/runs${NC}"
    echo ""
    echo -e "  ${DIM}The first user to register will become the administrator.${NC}"
    echo ""
  fi
}

main "$@"
