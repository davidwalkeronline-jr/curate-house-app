#!/bin/bash
# Installs Curate Drum Pad on macOS. Double click this file, or run it in Terminal.
# The AAX plugin goes to the Pro Tools plugin folder, which needs your Mac password.

set -e
cd "$(dirname "$0")"

AAX_DIR="/Library/Application Support/Avid/Audio/Plug-Ins"
VST3_DIR="$HOME/Library/Audio/Plug-Ins/VST3"
AU_DIR="$HOME/Library/Audio/Plug-Ins/Components"

install_bundle () {
    local bundle="$1" dest="$2" use_sudo="$3"
    if [ ! -e "$bundle" ]; then return; fi
    echo "Installing $bundle to $dest"
    $use_sudo mkdir -p "$dest"
    $use_sudo rm -rf "$dest/$bundle"
    $use_sudo cp -R "$bundle" "$dest/"
    # Files downloaded from the internet are quarantined by macOS; clear that and
    # apply a local signature so Apple Silicon Macs will load the plugin.
    $use_sudo xattr -dr com.apple.quarantine "$dest/$bundle" 2>/dev/null || true
    $use_sudo codesign --force --deep --sign - "$dest/$bundle" >/dev/null 2>&1 || true
}

install_bundle "Curate Drum Pad.aaxplugin" "$AAX_DIR" sudo
install_bundle "Curate Drum Pad.vst3" "$VST3_DIR" ""
install_bundle "Curate Drum Pad.component" "$AU_DIR" ""

if [ -e "Curate Drum Pad.app" ]; then
    echo "Installing Curate Drum Pad.app to /Applications"
    rm -rf "/Applications/Curate Drum Pad.app"
    cp -R "Curate Drum Pad.app" /Applications/
    xattr -dr com.apple.quarantine "/Applications/Curate Drum Pad.app" 2>/dev/null || true
    codesign --force --deep --sign - "/Applications/Curate Drum Pad.app" >/dev/null 2>&1 || true
fi

echo
echo "Done. Restart Pro Tools, then insert Curate Drum Pad on an Instrument track"
echo "(Insert > multichannel plug-in > Instrument > Curate Drum Pad)."
