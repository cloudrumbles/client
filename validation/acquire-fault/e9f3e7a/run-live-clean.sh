#!/usr/bin/env bash
set -euo pipefail
source /workspace/client-tools/native-env.sh
export DISPLAY=:93
export XDG_DATA_HOME=/workspace/client-assets/data
export XDG_CONFIG_HOME=/workspace/client-assets/config
export ALSOFT_DRIVERS=null LP_NUM_THREADS=2 RUST_LOG=info
export VK_LAYER_PATH=/workspace/client-tools/sysroot/usr/share/vulkan/explicit_layer.d
export VK_INSTANCE_LAYERS=VK_LAYER_KHRONOS_validation
fault_review_token=$(mktemp /tmp/pomme-fault-review-XXXXXX)
trap 'rm -f "$fault_review_token"' EXIT
python3 -B /workspace/minecraft-client-fault-review/pomme-client/tests/acquire_fault_integration.py \
  --binary /workspace/client-tools/acquire-fault-e9f3e7a-client \
  --output /workspace/native-results/acquire-e9f3e7a-proof-clean --frames 20 --timeout 300 -- \
  --launch-token "$fault_review_token" --version 26.3 --username FaultPhoton \
  --assets-dir /workspace/client-assets/assets \
  --versions-dir /workspace/client-assets/versions \
  --game-dir /workspace/client-assets/native-game \
  --quick-access-multiplayer 127.0.0.1:25577 --renderer-path shared \
  --shader-pack /workspace/photon-reference --shader-profile low \
  --shader-option SH_SKYLIGHT=false --shader-width 320 --shader-height 180
