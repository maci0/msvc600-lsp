#!/bin/sh
# Stands in for `wine cl.exe`: a long-lived process that starts a
# long-lived grandchild and then waits, ignoring the CL.EXE arguments.
# The grandchild's pid is written to $GRANDCHILD_PID_FILE so a test can
# check whether an abort reached past the direct child.
sleep 300 &
echo $! > "$GRANDCHILD_PID_FILE"
wait
