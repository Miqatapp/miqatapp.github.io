package io.github.miqatapp.questai;

import android.app.Activity;
import android.os.Bundle;

/** Plain 2D window (phones, the emulator, and as a fallback). The headset uses SpatialActivity. */
public class MainActivity extends Activity implements WebShell.Host {
  private WebShell shell;

  @Override protected void onCreate(Bundle state) {
    super.onCreate(state);
    shell = new WebShell(this, this);
    setContentView(shell.create(this, state));
  }
  @Override public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
    super.onRequestPermissionsResult(code, perms, results);
    shell.onPermissionsResult(code);
  }
  @Override public void onBackPressed() { shell.back(this::finish); }
  @Override protected void onSaveInstanceState(Bundle out) { super.onSaveInstanceState(out); shell.save(out); }
  // The WebView is deliberately not paused so listening continues while another app is in front.
  @Override protected void onDestroy() { shell.destroy(); super.onDestroy(); }

  @Override public boolean isSpatial() { return false; }
  @Override public void placeBoxes(String json) {}
  @Override public void clearBoxes() {}
  @Override public void setPanelScale(float scale) {}
  @Override public void moveBoxes(String json) {}
}
