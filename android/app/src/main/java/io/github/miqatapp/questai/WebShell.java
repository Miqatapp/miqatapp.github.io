package io.github.miqatapp.questai;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Bundle;
import android.provider.Settings;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import androidx.webkit.WebViewAssetLoader;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * The app's UI: a WebView showing the bundled web app (assets/www) from a secure origin so
 * getUserMedia works. Turns camera/mic requests into Android permission dialogs, provides
 * native text-to-speech, app launching and — in the AR activity — boxes placed in the room.
 */
public class WebShell {
  static final String TAG = "QuestAI";
  private static final String HOST = "appassets.androidplatform.net";
  private static final String START = "https://" + HOST + "/assets/www/index.html";
  private static final String HEADSET_CAMERA = "horizonos.permission.HEADSET_CAMERA";
  public static final int REQ_WEB = 2;

  /** Implemented by the activity hosting the UI. */
  public interface Host {
    boolean isSpatial();
    void placeBoxes(String json);
    void clearBoxes();
  }

  private final Activity act;
  private final Host host;
  private WebView web;
  private TextToSpeech tts;
  private boolean ttsReady = false;

  public WebShell(Activity act, Host host) { this.act = act; this.host = host; }

  public WebView getWebView() { return web; }

  public WebView create(Context ctx, Bundle state) {
    web = new WebView(ctx);
    web.setBackgroundColor(0xFF0A0B0D);
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);

    final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .setDomain(HOST)
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(act))
        .build();
    web.setWebViewClient(new WebViewClient() {
      @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        return loader.shouldInterceptRequest(req.getUrl());
      }
      @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        Uri u = req.getUrl();
        if (HOST.equals(u.getHost())) return false;
        try { act.startActivity(new Intent(Intent.ACTION_VIEW, u).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)); } catch (Exception ignored) {}
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override public void onPermissionRequest(final PermissionRequest req) { act.runOnUiThread(() -> handleWebPermission(req)); }
      @Override public boolean onConsoleMessage(ConsoleMessage m) {
        Log.i(TAG, m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
        return true;
      }
    });
    web.addJavascriptInterface(new Bridge(), "QuestAINative");
    if (state != null) web.restoreState(state); else web.loadUrl(START);

    // onInit can fire before the constructor returns, so the listener is attached afterwards.
    try {
      tts = new TextToSpeech(act, status -> ttsReady = status == TextToSpeech.SUCCESS);
      tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
        @Override public void onStart(String id) {}
        @Override public void onDone(String id) { notifySpoken(id); }
        @Override public void onError(String id) { notifySpoken(id); }
        @Override public void onStop(String id, boolean interrupted) { notifySpoken(id); }
      });
    } catch (Exception e) { Log.w(TAG, "TTS unavailable", e); tts = null; }
    return web;
  }

  private boolean has(String p) { return act.checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

  private List<String> missing(String[] perms) {
    List<String> out = new ArrayList<>();
    for (String p : perms) if (!has(p)) out.add(p);
    return out;
  }

  // WebView may ask for the mic and the camera at the same time. Android only shows one
  // dialog at a time, so queue page requests and answer them all once the user decides.
  private final List<PermissionRequest> queue = new ArrayList<>();
  private boolean asking = false;

  private static List<String> androidPerms(PermissionRequest req) {
    List<String> need = new ArrayList<>();
    for (String r : req.getResources()) {
      if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) need.add(Manifest.permission.RECORD_AUDIO);
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) { need.add(Manifest.permission.CAMERA); need.add(HEADSET_CAMERA); }
    }
    return need;
  }

  private void handleWebPermission(PermissionRequest req) {
    queue.add(req);
    if (!asking) askNext();
  }

  private void askNext() {
    List<String> miss = new ArrayList<>();
    for (PermissionRequest r : queue)
      for (String p : androidPerms(r))
        if (!has(p) && !miss.contains(p) && !askedOnce.contains(p)) miss.add(p);
    if (miss.isEmpty()) { answerQueue(); return; }
    asking = true;
    askedOnce.addAll(miss);
    act.requestPermissions(miss.toArray(new String[0]), REQ_WEB);
  }

  // Guards against re-asking inside one round when the user taps "Don't allow".
  private final List<String> askedOnce = new ArrayList<>();

  private void answerQueue() {
    for (PermissionRequest r : queue) grantAllowed(r);
    queue.clear();
    askedOnce.clear(); // a later retry from the page may ask again
  }

  private void grantAllowed(PermissionRequest req) {
    List<String> ok = new ArrayList<>();
    for (String r : req.getResources()) {
      if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && has(Manifest.permission.RECORD_AUDIO)) ok.add(r);
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && has(Manifest.permission.CAMERA)) ok.add(r);
    }
    if (ok.isEmpty()) req.deny(); else req.grant(ok.toArray(new String[0]));
  }

  /** Forward from the activity's onRequestPermissionsResult. */
  public void onPermissionsResult(int code) {
    if (code != REQ_WEB) return;
    asking = false;
    askNext();
  }

  private void notifySpoken(String id) {
    act.runOnUiThread(() -> web.evaluateJavascript("window.questaiSpoken && window.questaiSpoken(" + jsString(id) + ")", null));
  }

  private static String norm(String s) { return s == null ? "" : s.toLowerCase(Locale.ROOT).replaceAll("[^\\p{L}\\p{N}]", ""); }

  private static String jsString(String s) {
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
  }

  public void back(Runnable finish) {
    web.evaluateJavascript("window.questaiBack ? String(window.questaiBack()) : 'false'", v -> {
      if (v != null && v.contains("true")) return;
      if (web.canGoBack()) web.goBack(); else finish.run();
    });
  }

  public void save(Bundle out) { if (web != null) web.saveState(out); }

  public void destroy() {
    act.stopService(new Intent(act, ListenService.class));
    if (tts != null) tts.shutdown();
    if (web != null) web.destroy();
  }

  public void js(String code) { if (web != null) act.runOnUiThread(() -> web.evaluateJavascript(code, null)); }

  /** Exposed to JavaScript as window.QuestAINative */
  class Bridge {
    @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }

    @JavascriptInterface public void openAppSettings() {
      act.runOnUiThread(() -> {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", act.getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        act.startActivity(i);
      });
    }

    /** Launches an installed app whose name best matches. Returns a short result for the AI. */
    @JavascriptInterface public String launchApp(String name) {
      String want = norm(name);
      if (want.isEmpty()) return "No app name given.";
      android.content.pm.PackageManager pm = act.getPackageManager();
      Intent q = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
      List<android.content.pm.ResolveInfo> apps = pm.queryIntentActivities(q, 0);
      android.content.pm.ResolveInfo best = null; int bestScore = 0;
      StringBuilder names = new StringBuilder();
      for (android.content.pm.ResolveInfo ri : apps) {
        String label = String.valueOf(ri.loadLabel(pm));
        if (names.length() < 600) names.append(label).append(", ");
        String l = norm(label);
        int score = l.equals(want) ? 3 : (l.contains(want) || want.contains(l)) ? 2 : 0;
        if (score > bestScore) { best = ri; bestScore = score; }
      }
      if (best == null) return "Not installed. Installed apps: " + names;
      final Intent launch = pm.getLaunchIntentForPackage(best.activityInfo.packageName);
      if (launch == null) return "Cannot open " + best.loadLabel(pm);
      launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      act.runOnUiThread(() -> { try { act.startActivity(launch); } catch (Exception e) { Log.w(TAG, "launch", e); } });
      return "Opened " + best.loadLabel(pm);
    }

    /** Opens a https link in the Quest browser (used for AR mode, which needs WebXR). */
    @JavascriptInterface public void openUrl(String url) {
      if (url == null || !url.startsWith("https://")) return;
      act.runOnUiThread(() -> {
        try {
          Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
          i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          act.startActivity(i);
        } catch (Exception e) { Log.w(TAG, "openUrl", e); }
      });
    }

    /** True in the AR (passthrough) activity: boxes can be placed in the room. */
    @JavascriptInterface public boolean isSpatial() { return host != null && host.isSpatial(); }
    /** json: {boxes:[{label, box:[ymin,xmin,ymax,xmax]}], ageMs, fov, offX, offY, aspect} */
    @JavascriptInterface public void placeBoxes(String json) { if (host != null) act.runOnUiThread(() -> host.placeBoxes(json)); }
    @JavascriptInterface public void clearBoxes() { if (host != null) act.runOnUiThread(host::clearBoxes); }

    @JavascriptInterface public boolean canSpeak() { return ttsReady; }

    @JavascriptInterface public void speak(String text, String lang, String id) {
      if (!ttsReady) { notifySpoken(id); return; }
      Locale loc = "ar".equals(lang) ? new Locale("ar") : Locale.US;
      if (tts.isLanguageAvailable(loc) >= TextToSpeech.LANG_AVAILABLE) tts.setLanguage(loc);
      tts.speak(text, TextToSpeech.QUEUE_ADD, null, id);
    }

    @JavascriptInterface public void stopSpeaking() { if (ttsReady) tts.stop(); }

    /** Keep the microphone alive while other apps are in front (foreground service). */
    @JavascriptInterface public void setBackgroundListening(boolean on) {
      act.runOnUiThread(() -> {
        Intent i = new Intent(act, ListenService.class);
        try {
          if (on) act.startForegroundService(i); else act.stopService(i);
        } catch (Exception e) { Log.w(TAG, "listen service", e); }
      });
    }
  }
}
