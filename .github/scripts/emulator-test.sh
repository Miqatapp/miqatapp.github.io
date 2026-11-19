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

# fresh emulators keep updating the WebView provider for a while after boot
until [ "$(adb shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done
sleep 45
adb shell dumpsys webviewupdate | grep -iE 'current webview|package' | head -5 > shots/webview.txt
adb install -r QuestAI.apk 2>&1 | tail -1 | tee shots/install.txt
sleep 5
adb logcat -c
adb shell am start -W -n $PKG/.MainActivity | tee shots/launch.txt
sleep 6
if ! adb shell pidof $PKG >/dev/null; then echo 'crashed on first start, retrying' | tee shots/retry.txt; sleep 15; adb shell am start -W -n $PKG/.MainActivity; fi
sleep 3
shot 0-after-launch
sleep 6
shot 1-first-launch
adb shell pidof $PKG > shots/pid.txt || echo 'not running' > shots/pid.txt
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
adb logcat -d -s QuestAI:V chromium:E AndroidRuntime:E ActivityManager:W ActivityTaskManager:W > shots/console.log
adb logcat -d *:E > shots/errors.log
echo done
