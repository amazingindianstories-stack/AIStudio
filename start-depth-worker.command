#!/usr/bin/env bash
# Double-click this in Finder (or run `./start-depth-worker.command` in a
# terminal) to start the local depth-map worker. Just wraps
# depth-worker/start.sh so you don't have to remember the path every morning.
# Leave the terminal window open — closing it (or the machine sleeping) is
# what flips the nav bar's status pill to offline.
cd "$(dirname "$0")/depth-worker" || exit 1
exec ./start.sh
