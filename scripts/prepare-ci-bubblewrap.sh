#!/usr/bin/env bash
set -euo pipefail

# Ubuntu's package transaction scans the hosted image's full dpkg database and
# runs post-install hooks. CI needs only the signed-archive payload, so pin and
# verify that payload before extracting it into the ephemeral runner directory.
# The archive pool deletes a version once an update supersedes it; Launchpad's
# librarian keeps every published file, so it serves the pin after that.
readonly BUBBLEWRAP_VERSION='0.9.0-1ubuntu0.3'
readonly BUBBLEWRAP_SHA256='2461f1beee9cb04c8942739fe1a2b37e7b7c2a3d518f0779dc75f9245baa3094'
readonly BUBBLEWRAP_FILE="bubblewrap_${BUBBLEWRAP_VERSION}_amd64.deb"
readonly BUBBLEWRAP_URLS=(
  "https://archive.ubuntu.com/ubuntu/pool/main/b/bubblewrap/${BUBBLEWRAP_FILE}"
  "https://launchpad.net/ubuntu/+archive/primary/+files/${BUBBLEWRAP_FILE}"
)

: "${RUNNER_TEMP:?prepare-ci-bubblewrap requires RUNNER_TEMP}"
: "${GITHUB_PATH:?prepare-ci-bubblewrap requires GITHUB_PATH}"

if [[ "$(uname -s)" != 'Linux' || "$(uname -m)" != 'x86_64' ]]; then
  echo 'prepare-ci-bubblewrap supports only Linux x86_64 hosted runners' >&2
  exit 1
fi

archive="${RUNNER_TEMP}/${BUBBLEWRAP_FILE}"
root="${RUNNER_TEMP}/dsh-bubblewrap"

downloaded=''
for url in "${BUBBLEWRAP_URLS[@]}"; do
  if curl --fail --silent --show-error --location --retry 3 --output "$archive" "$url"; then
    downloaded="$url"
    break
  fi
done
if [[ -z "$downloaded" ]]; then
  echo "prepare-ci-bubblewrap could not download ${BUBBLEWRAP_FILE}" >&2
  exit 1
fi
printf '%s  %s\n' "$BUBBLEWRAP_SHA256" "$archive" | sha256sum --check --status
mkdir -p "$root"
dpkg-deb --extract "$archive" "$root"
printf '%s\n' "$root/usr/bin" >> "$GITHUB_PATH"

sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0 \
  || echo 'apparmor userns knob absent — the functional probe decides'
"$root/usr/bin/bwrap" --version
"$root/usr/bin/bwrap" --ro-bind / / --dev /dev --unshare-pid --proc /proc --die-with-parent -- true
echo 'bubblewrap functional probe passed'
