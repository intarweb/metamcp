#!/bin/sh

set -e

echo "Starting MetaMCP services..."

# Function to wait for postgres
wait_for_postgres() {
    echo "Waiting for PostgreSQL to be ready..."
    until pg_isready -h "$POSTGRES_HOST" -p "$POSTGRES_PORT" -U "$POSTGRES_USER"; do
        echo "PostgreSQL is not ready - sleeping 2 seconds"
        sleep 2
    done
    echo "PostgreSQL is ready!"
}

# Wait until a local TCP port accepts connections (bounded). The old code used
# a fixed `sleep 3` + `kill -0`, which misclassified a slow-but-healthy boot as
# dead and exited the container — a restart loop on cold caches. Probing the
# actual port proves the service is LISTENING, not merely that the wrapper
# process is alive.
wait_for_port() {
    local host="$1"
    local port="$2"
    local timeout_s="${3:-60}"
    local deadline=$(( $(date +%s) + timeout_s ))
    while [ "$(date +%s)" -lt "$deadline" ]; do
        if curl -fsS -o /dev/null "http://${host}:${port}/health" 2>/dev/null; then
            echo "✅ Service on ${host}:${port} is healthy"
            return 0
        fi
        sleep 1
    done
    echo "❌ Service on ${host}:${port} did not become healthy within ${timeout_s}s"
    return 1
}

# Function to run migrations
run_migrations() {
    echo "Running database migrations..."
    cd /app/apps/backend

    # Check if migrations need to be run
    if [ -d "drizzle" ] && [ "$(ls -A drizzle/*.sql 2>/dev/null)" ]; then
        echo "Found migration files, running migrations..."
        # Use local drizzle-kit since env vars are available at system level in Docker
        if pnpm exec drizzle-kit migrate; then
            echo "Migrations completed successfully!"
        else
            echo "❌ Migration failed! Exiting..."
            exit 1
        fi
    else
        echo "No migrations found or directory empty"
    fi

    cd /app
}

# Set default values for postgres connection if not provided
POSTGRES_HOST=${POSTGRES_HOST:-postgres}
POSTGRES_PORT=${POSTGRES_PORT:-5432}
POSTGRES_USER=${POSTGRES_USER:-postgres}

# Wait for PostgreSQL
wait_for_postgres

# Run migrations
run_migrations

# Start backend in the background
echo "Starting backend server..."
cd /app/apps/backend
PORT=12009 node dist/index.js &
BACKEND_PID=$!

# Wait for the backend to actually bind + answer /health. Docker's stop-grace
# + the trap below make this bounded even if it never comes up.
if ! wait_for_port localhost 12009 90; then
    echo "❌ Backend server failed to become healthy! Exiting..."
    exit 1
fi
echo "✅ Backend server started successfully (PID: $BACKEND_PID)"

# Start frontend
echo "Starting frontend server..."
cd /app/apps/frontend
PORT=12008 pnpm start &
FRONTEND_PID=$!

# Wait for the frontend to bind. The Next proxy rewrites /health to the backend
# (12009), so 12008 answering on its own assets is enough to prove the frontend
# is up; the backend health is already gated above.
if ! wait_for_port localhost 12008 90; then
    echo "❌ Frontend server failed to become healthy! Exiting..."
    kill $BACKEND_PID 2>/dev/null
    exit 1
fi
echo "✅ Frontend server started successfully (PID: $FRONTEND_PID)"

# Function to cleanup on exit
cleanup() {
    echo "Shutting down services..."
    kill $BACKEND_PID 2>/dev/null || true
    kill $FRONTEND_PID 2>/dev/null || true
    wait $BACKEND_PID 2>/dev/null || true
    wait $FRONTEND_PID 2>/dev/null || true
    echo "Services stopped"
}

# Trap signals for graceful shutdown
trap cleanup TERM INT

echo "Services started successfully!"
echo "Backend running on port 12009"
echo "Frontend running on port 12008"

# Wait for both processes
wait $BACKEND_PID
wait $FRONTEND_PID 