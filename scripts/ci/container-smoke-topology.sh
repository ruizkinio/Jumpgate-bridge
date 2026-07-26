#!/usr/bin/env bash
set -euo pipefail

if [[ "$#" -ne 0 ]]; then
  echo "Container smoke topology failed: arguments are not accepted." >&2
  exit 1
fi

required_environment=(
  CONTAINER_NODE_IMAGE
  CONTAINER_POSTGRES_IMAGE
  CONTAINER_REDIS_IMAGE
  GITHUB_SHA
  GITHUB_WORKSPACE
  RUNNER_TEMP
)
for name in "${required_environment[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "Container smoke topology failed: required environment is missing." >&2
    exit 1
  fi
done
for image in "$CONTAINER_NODE_IMAGE" "$CONTAINER_POSTGRES_IMAGE" "$CONTAINER_REDIS_IMAGE"; do
  if [[ ! "$image" =~ ^[^@[:space:]]+@sha256:[a-f0-9]{64}$ ]]; then
    echo "Container smoke topology failed: container image is not digest-pinned." >&2
    exit 1
  fi
done
if [[ ! "$GITHUB_SHA" =~ ^([a-f0-9]{40}|[a-f0-9]{64})$ ]] ||
  [[ "$GITHUB_WORKSPACE" != /* ]] ||
  [[ "$RUNNER_TEMP" != /* ]]; then
  echo "Container smoke topology failed: runtime identity is invalid." >&2
  exit 1
fi
test -f "$GITHUB_WORKSPACE/scripts/ci/container-smoke-env.js"
test -f "$GITHUB_WORKSPACE/scripts/ci/http-smoke.js"
test -f "$GITHUB_WORKSPACE/scripts/ci/s3-protocol-harness.js"
test -f "$GITHUB_WORKSPACE/package.json"

unset NODE_OPTIONS NODE_PATH EXPECTED_VERSION
unset DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG DOCKER_API_VERSION \
  DOCKER_CERT_PATH DOCKER_TLS_VERIFY
DOCKER_BIN="${JUMPGATE_DOCKER_BIN:-}"
if [[ -z "$DOCKER_BIN" ]]; then
  if ! DOCKER_BIN="$(command -v docker)"; then
    echo "Container smoke topology failed: Docker executable is unavailable." >&2
    exit 1
  fi
fi
if [[ "$DOCKER_BIN" != /* || ! -f "$DOCKER_BIN" || ! -x "$DOCKER_BIN" ]]; then
  echo "Container smoke topology failed: Docker executable is invalid." >&2
  exit 1
fi
readonly DOCKER_BIN
docker_cli() {
  "$DOCKER_BIN" "$@"
}
readonly -f docker_cli
unset JUMPGATE_DOCKER_BIN

EXPECTED_VERSION="$(
  node -p "JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).version" \
    "$GITHUB_WORKSPACE/package.json"
)"
if [[ ! "$EXPECTED_VERSION" =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$ ]]; then
  echo "Container smoke topology failed: package version is invalid." >&2
  exit 1
fi
umask 077

runtime_dir="$RUNNER_TEMP/jumpgate-container"
env_file="$runtime_dir/runtime.env"
harness_env="$runtime_dir/harness.env"
postgres_env="$runtime_dir/postgres.env"
secret_values="$runtime_dir/secret-values.txt"
probe_id=""
negative_pid=""
network="jumpgate-container-ci"
containers=(
  jumpgate-http-smoke-ci
  jumpgate-http-smoke-ci-public
  jumpgate-bridge-ci
  jumpgate-bridge-ci-public
  jumpgate-s3-ci
  jumpgate-s3-ci-public
  jumpgate-postgres-ci
  jumpgate-redis-ci
)

capture_container_log() {
  local container="$1"
  local label="$2"
  local raw_log="$runtime_dir/logs/$label.raw.log"
  local redacted_log="$runtime_dir/logs/$label.log"
  local audit_status=0
  if ! docker_cli container inspect "$container" >/dev/null 2>&1; then
    return 0
  fi
  docker_cli logs "$container" >"$raw_log" 2>&1 || audit_status=1
  chmod 0600 "$raw_log"
  node "$GITHUB_WORKSPACE/scripts/ci/container-smoke-env.js" audit \
    --input="$raw_log" \
    --secret-values="$secret_values" || audit_status=1
  node "$GITHUB_WORKSPACE/scripts/ci/container-smoke-env.js" redact \
    --input="$raw_log" \
    --output="$redacted_log" \
    --secret-values="$secret_values" || return 1
  rm -f -- "$raw_log"
  echo "::group::Redacted $label log"
  cat "$redacted_log"
  echo "::endgroup::"
  return "$audit_status"
}

cleanup() {
  local status=$?
  local cleanup_status=0
  trap - EXIT
  set +e
  if [[ -n "$negative_pid" ]]; then
    kill "$negative_pid" >/dev/null 2>&1 || true
    wait "$negative_pid" >/dev/null 2>&1 || true
    negative_pid=""
  fi
  if [[ -f "$secret_values" ]]; then
    capture_container_log jumpgate-bridge-ci cleanup-positive-app || cleanup_status=1
    capture_container_log jumpgate-s3-ci cleanup-positive-s3 || cleanup_status=1
    capture_container_log jumpgate-bridge-ci-public cleanup-public-app || cleanup_status=1
    capture_container_log jumpgate-s3-ci-public cleanup-public-s3 || cleanup_status=1
  fi
  for container in "${containers[@]}"; do
    docker_cli rm --force "$container" >/dev/null 2>&1 || true
  done
  docker_cli network rm "$network" >/dev/null 2>&1 || true
  rm -rf -- "$runtime_dir"
  for container in "${containers[@]}"; do
    if docker_cli container inspect "$container" >/dev/null 2>&1; then
      cleanup_status=1
    fi
  done
  if docker_cli network inspect "$network" >/dev/null 2>&1; then
    cleanup_status=1
  fi
  if [[ -e "$runtime_dir" ]]; then
    cleanup_status=1
  fi
  if [[ "$cleanup_status" -ne 0 ]]; then
    echo "Container smoke topology cleanup failed." >&2
  fi
  if [[ "$status" -eq 0 && "$cleanup_status" -ne 0 ]]; then
    status="$cleanup_status"
  fi
  exit "$status"
}
trap cleanup EXIT

test ! -e "$runtime_dir"
mkdir -m 0700 "$runtime_dir"
mkdir -m 0700 "$runtime_dir/logs" "$runtime_dir/tls" "$runtime_dir/tls/server"
node "$GITHUB_WORKSPACE/scripts/ci/container-smoke-env.js" generate \
  --runtime-env="$env_file" \
  --harness-env="$harness_env" \
  --postgres-env="$postgres_env" \
  --secret-values="$secret_values"
test "$(grep -c '^S3_HARNESS_PROBE_ID=' "$harness_env")" = "1"
probe_id="$(sed -n 's/^S3_HARNESS_PROBE_ID=//p' "$harness_env")"
[[ "$probe_id" =~ ^[a-f0-9]{32}$ ]]

openssl genpkey -algorithm EC \
  -pkeyopt ec_paramgen_curve:P-256 \
  -out "$runtime_dir/tls/ca.key" >/dev/null 2>&1
openssl req -new -x509 -sha256 -days 1 \
  -key "$runtime_dir/tls/ca.key" \
  -out "$runtime_dir/tls/ca.crt" \
  -addext "basicConstraints=critical,CA:TRUE" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -subj "/CN=Jumpgate CI S3 Root" >/dev/null 2>&1
openssl genpkey -algorithm EC \
  -pkeyopt ec_paramgen_curve:P-256 \
  -out "$runtime_dir/tls/server/server.key" >/dev/null 2>&1
openssl req -new -sha256 \
  -key "$runtime_dir/tls/server/server.key" \
  -out "$runtime_dir/tls/server/server.csr" \
  -subj "/CN=fly.storage.tigris.dev" >/dev/null 2>&1
cat >"$runtime_dir/tls/server/server.ext" <<'EOF'
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:fly.storage.tigris.dev,DNS:*.fly.storage.tigris.dev
EOF
openssl x509 -req -sha256 -days 1 \
  -in "$runtime_dir/tls/server/server.csr" \
  -CA "$runtime_dir/tls/ca.crt" \
  -CAkey "$runtime_dir/tls/ca.key" \
  -CAcreateserial \
  -extfile "$runtime_dir/tls/server/server.ext" \
  -out "$runtime_dir/tls/server/server.crt" >/dev/null 2>&1
chmod 0400 "$runtime_dir/tls/ca.key" "$runtime_dir/tls/server/server.key"
chmod 0444 "$runtime_dir/tls/ca.crt" "$runtime_dir/tls/server/server.crt"

docker_cli pull "$CONTAINER_NODE_IMAGE" >/dev/null
docker_cli pull "$CONTAINER_POSTGRES_IMAGE" >/dev/null
docker_cli pull "$CONTAINER_REDIS_IMAGE" >/dev/null
docker_cli network create --driver bridge --internal "$network" >/dev/null

docker_cli run --detach \
  --name jumpgate-postgres-ci \
  --network "$network" \
  --network-alias jumpgate-postgres \
  --env-file "$postgres_env" \
  --health-cmd "pg_isready -U jumpgate -d jumpgate_container_ci" \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 30 \
  "$CONTAINER_POSTGRES_IMAGE" >/dev/null
docker_cli run --detach \
  --name jumpgate-redis-ci \
  --network "$network" \
  --network-alias jumpgate-redis \
  --health-cmd "redis-cli ping" \
  --health-interval 1s \
  --health-timeout 3s \
  --health-retries 30 \
  "$CONTAINER_REDIS_IMAGE" >/dev/null
docker_cli run --detach \
  --name jumpgate-s3-ci \
  --network "$network" \
  --network-alias fly.storage.tigris.dev \
  --network-alias jumpgate-ci-subtitles.fly.storage.tigris.dev \
  --env-file "$harness_env" \
  --mount "type=bind,src=$GITHUB_WORKSPACE/scripts/ci/s3-protocol-harness.js,dst=/opt/jumpgate/s3-protocol-harness.js,readonly" \
  --mount "type=bind,src=$runtime_dir/tls/server,dst=/run/jumpgate-tls,readonly" \
  "$CONTAINER_NODE_IMAGE" \
  node /opt/jumpgate/s3-protocol-harness.js >/dev/null

wait_healthy() {
  local container="$1"
  local status
  for _attempt in {1..60}; do
    status="$(docker_cli inspect --format '{{.State.Health.Status}}' "$container")"
    if [[ "$status" == "healthy" ]]; then
      return 0
    fi
    if [[ "$status" == "unhealthy" ]]; then
      return 1
    fi
    sleep 1
  done
  return 1
}

wait_harness() {
  local container="$1"
  local mode="$2"
  local expected
  expected="{\"schema\":\"jumpgate-s3-harness-v2\",\"event\":\"ready\",\"probeId\":\"$probe_id\",\"mode\":\"$mode\"}"
  for _attempt in {1..30}; do
    if docker_cli logs "$container" 2>&1 | grep -Fqx -- "$expected"; then
      return 0
    fi
    test "$(docker_cli inspect --format '{{.State.Running}}' "$container")" = "true"
    sleep 1
  done
  return 1
}

wait_public_attestation() {
  local container="$1"
  local expected
  expected='^\{"schema":"jumpgate-s3-harness-v2","event":"operation","probeId":"'"$probe_id"'","sequenceId":"[a-f0-9]{32}","authenticated":true,"operation":"GetBucketPolicyStatus","outcome":"accepted","scopeId":null,"objectId":null,"versionSelector":"none","requestedVersionId":null,"versionId":null,"objectCount":null,"isPublic":true\}$'
  for _attempt in {1..60}; do
    if docker_cli logs "$container" 2>&1 | grep -Eq -- "$expected"; then
      return 0
    fi
    test "$(docker_cli inspect --format '{{.State.Running}}' "$container")" = "true"
    sleep 1
  done
  return 1
}

wait_healthy jumpgate-postgres-ci
wait_healthy jumpgate-redis-ci
wait_harness jumpgate-s3-ci private

docker_cli run --rm \
  --name jumpgate-release-transition-ci \
  --network "$network" \
  --env-file "$env_file" \
  --env JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=transition \
  --mount "type=bind,src=$runtime_dir/tls/ca.crt,dst=/run/jumpgate-ca/ca.crt,readonly" \
  "jumpgate-bridge:$GITHUB_SHA" \
  node scripts/production-release-protocols.js apply-env >/dev/null
docker_cli run --rm \
  --name jumpgate-release-v6-ci \
  --network "$network" \
  --env-file "$env_file" \
  --env JUMPGATE_REDIS_PLAYBACK_CLAIM_ROLLOUT_MODE=v6 \
  --mount "type=bind,src=$runtime_dir/tls/ca.crt,dst=/run/jumpgate-ca/ca.crt,readonly" \
  "jumpgate-bridge:$GITHUB_SHA" \
  node scripts/production-release-protocols.js apply-env >/dev/null

docker_cli run --detach \
  --name jumpgate-bridge-ci \
  --network "$network" \
  --env-file "$env_file" \
  --mount "type=bind,src=$runtime_dir/tls/ca.crt,dst=/run/jumpgate-ca/ca.crt,readonly" \
  "jumpgate-bridge:$GITHUB_SHA" >/dev/null
test "$(docker_cli inspect --format '{{.Image}}' jumpgate-bridge-ci)" = \
  "$(docker_cli image inspect --format '{{.Id}}' "jumpgate-bridge:$GITHUB_SHA")"
docker_cli run \
  --name jumpgate-http-smoke-ci \
  --network "$network" \
  --mount "type=bind,src=$GITHUB_WORKSPACE/scripts/ci/http-smoke.js,dst=/opt/jumpgate/http-smoke.js,readonly" \
  "$CONTAINER_NODE_IMAGE" \
  node /opt/jumpgate/http-smoke.js \
  --base-url=http://jumpgate-bridge-ci:7515 \
  --expected-version="$EXPECTED_VERSION" \
  --expected-build-sha="$GITHUB_SHA" \
  --expected-readiness=ready \
  --deadline-ms=60000 \
  --delay-ms=1000
docker_cli rm jumpgate-http-smoke-ci >/dev/null
docker_cli stop --time 10 jumpgate-bridge-ci jumpgate-s3-ci >/dev/null
capture_container_log jumpgate-bridge-ci positive-app
capture_container_log jumpgate-s3-ci positive-s3
node "$GITHUB_WORKSPACE/scripts/ci/container-smoke-env.js" verify-private-lifecycle \
  --input="$runtime_dir/logs/positive-s3.log" \
  --probe-id="$probe_id"
docker_cli rm jumpgate-bridge-ci jumpgate-s3-ci >/dev/null

docker_cli run --detach \
  --name jumpgate-s3-ci-public \
  --network "$network" \
  --network-alias fly.storage.tigris.dev \
  --network-alias jumpgate-ci-subtitles.fly.storage.tigris.dev \
  --env-file "$harness_env" \
  --env S3_HARNESS_PUBLIC_ATTESTATION=1 \
  --env S3_HARNESS_PUBLIC_DELAY_MS=1000 \
  --mount "type=bind,src=$GITHUB_WORKSPACE/scripts/ci/s3-protocol-harness.js,dst=/opt/jumpgate/s3-protocol-harness.js,readonly" \
  --mount "type=bind,src=$runtime_dir/tls/server,dst=/run/jumpgate-tls,readonly" \
  "$CONTAINER_NODE_IMAGE" \
  node /opt/jumpgate/s3-protocol-harness.js >/dev/null
wait_harness jumpgate-s3-ci-public public
docker_cli run --detach \
  --name jumpgate-bridge-ci-public \
  --network "$network" \
  --env-file "$env_file" \
  --mount "type=bind,src=$runtime_dir/tls/ca.crt,dst=/run/jumpgate-ca/ca.crt,readonly" \
  "jumpgate-bridge:$GITHUB_SHA" >/dev/null
test "$(docker_cli inspect --format '{{.Image}}' jumpgate-bridge-ci-public)" = \
  "$(docker_cli image inspect --format '{{.Id}}' "jumpgate-bridge:$GITHUB_SHA")"
negative_stdout="$runtime_dir/logs/public-http-smoke.stdout.log"
negative_stderr="$runtime_dir/logs/public-http-smoke.stderr.log"
docker_cli run \
  --name jumpgate-http-smoke-ci-public \
  --network "$network" \
  --mount "type=bind,src=$GITHUB_WORKSPACE/scripts/ci/http-smoke.js,dst=/opt/jumpgate/http-smoke.js,readonly" \
  "$CONTAINER_NODE_IMAGE" \
  node /opt/jumpgate/http-smoke.js \
  --base-url=http://jumpgate-bridge-ci-public:7515 \
  --expected-version="$EXPECTED_VERSION" \
  --expected-build-sha="$GITHUB_SHA" \
  --expected-readiness=not-ready \
  --deadline-ms=15000 \
  --delay-ms=50 \
  >"$negative_stdout" 2>"$negative_stderr" &
negative_pid=$!

# This dedicated harness has no client until the negative smoke starts.
# Verify its canonical, secret-free proof before accepting the smoke result.
wait_public_attestation jumpgate-s3-ci-public
capture_container_log jumpgate-s3-ci-public public-s3-attestation
node "$GITHUB_WORKSPACE/scripts/ci/container-smoke-env.js" verify-public-attestation \
  --input="$runtime_dir/logs/public-s3-attestation.log" \
  --probe-id="$probe_id"

set +e
wait "$negative_pid"
negative_status=$?
set -e
negative_pid=""
cat "$negative_stdout"
cat "$negative_stderr" >&2
if [[ "$negative_status" -ne 0 ]]; then
  exit "$negative_status"
fi
docker_cli rm jumpgate-http-smoke-ci-public >/dev/null

docker_cli stop --time 10 jumpgate-bridge-ci-public jumpgate-s3-ci-public >/dev/null
capture_container_log jumpgate-bridge-ci-public public-app
capture_container_log jumpgate-s3-ci-public public-s3-final
node "$GITHUB_WORKSPACE/scripts/ci/container-smoke-env.js" verify-public-attestation \
  --input="$runtime_dir/logs/public-s3-final.log" \
  --probe-id="$probe_id"
docker_cli rm jumpgate-bridge-ci-public jumpgate-s3-ci-public >/dev/null
