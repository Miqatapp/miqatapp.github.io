#!/usr/bin/env bash
# Runs inside the Android emulator job. Every step is best-effort so we always get screenshots.
PKG=io.github.miqatapp.questai
mkdir -p shots
shot() { adb exec-out screencap -p > "shots/$1.png"; echo "shot $1"; }
dump() { adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1; adb pull /sdcard/ui.xml /tmp/ui.xml >/dev/null 2>&1; cp /tmp/ui.xml "shots/$1.xml" 2>/dev/null; }
tap() { # tap <regex>
  dump tmp
  local xy; xy=$(python3 .github/scripts/find_node.py /tmp/ui.xml "$1")
  if [ -n "$xy" ]; then adb shell input tap $xy; echo "tapped '$1' at $xy"; return 0; fi
  echo "not found: $1"; return 1
}

adb install -r QuestAI.apk 2>&1 | tail -1 | tee shots/install.txt
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity | tee shots/launch.txt
sleep 12
shot 1-first-launch
for i in 1 2 3; do
  tap 'While using the app|Allow|ALLOW|Only this time' || break
  sleep 2
done
sleep 4
shot 2-main
dump 2-main

tap '^settings$' && sleep 2 && shot 3-settings
tap '^تم$|^Done$' ; sleep 1

tap '^كاميرا$|^Camera$' ; sleep 6
shot 4-camera

tap '^مباشر$|^Live$' ; sleep 3
shot 5-live

adb shell dumpsys package $PKG | grep -E 'permission|granted=' > shots/permissions.txt
adb logcat -d -s QuestAI:V chromium:E > shots/console.log
echo done
