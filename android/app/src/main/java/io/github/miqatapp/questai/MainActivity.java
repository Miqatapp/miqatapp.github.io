package io.github.miqatapp.questai;

import android.Manifest;
import android.app.Activity;
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
 * Native shell: the UI is bundled in assets/www and served from a secure origin so that
 * getUserMedia works. Camera/mic requests from the page are turned into real Android
 * permission dialogs, and text-to-speech is provided natively (WebView has no speechSynthesis).
 */
public class MainActivity extends Activity {
  private static final String TAG = "QuestAI";
  private static final String HOST = "appassets.androidplatform.net";
  private static final String START = "https://" + HOST + "/assets/www/index.html";
  private static final String HEADSET_CAMERA = "horizonos.permission.HEADSET_CAMERA";
  private static final int REQ_STARTUP = 1, REQ_WEB = 2;

  private WebView web;
  private PermissionRequest pending;
  private TextToSpeech tts;
  private boolean ttsReady = false;

  @Override
  protected void onCreate(Bundle state) {
    super.onCreate(state);
    WebView.setWebContentsDebuggingEnabled(true);
    web = new WebView(this);
    web.setBackgroundColor(0xFF0A0B0D);
    setContentView(web);

    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(false);

    final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
        .setDomain(HOST)
        .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
        .build();

    web.setWebViewClient(new WebViewClient() {
      @Override
      public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
        return loader.shouldInterceptRequest(req.getUrl());
      }
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
        Uri u = req.getUrl();
        if (HOST.equals(u.getHost())) return false;
        try { startActivity(new Intent(Intent.ACTION_VIEW, u)); } catch (Exception ignored) {}
        return true;
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onPermissionRequest(final PermissionRequest req) {
        runOnUiThread(() -> handleWebPermission(req));
      }
      @Override
      public boolean onConsoleMessage(ConsoleMessage m) {
        Log.i(TAG, m.messageLevel() + " " + m.message() + " @" + m.sourceId() + ":" + m.lineNumber());
        return true;
      }
    });
    web.addJavascriptInterface(new Bridge(), "QuestAINative");

    if (state != null) web.restoreState(state);
    else web.loadUrl(START);

    // onInit can fire before the constructor returns, so the listener is attached afterwards.
    try {
      tts = new TextToSpeech(this, status -> ttsReady = status == TextToSpeech.SUCCESS);
      tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
        @Override public void onStart(String id) {}
        @Override public void onDone(String id) { notifySpoken(id); }
        @Override public void onError(String id) { notifySpoken(id); }
        @Override public void onStop(String id, boolean interrupted) { notifySpoken(id); }
      });
    } catch (Exception e) {
      Log.w(TAG, "TTS unavailable", e);
      tts = null;
    }

    // Ask right away so the system dialogs appear on first launch.
    List<String> missing = missing(new String[]{Manifest.permission.RECORD_AUDIO, Manifest.permission.CAMERA, HEADSET_CAMERA});
    if (!missing.isEmpty()) requestPermissions(missing.toArray(new String[0]), REQ_STARTUP);
  }

  private boolean has(String p) { return checkSelfPermission(p) == PackageManager.PERMISSION_GRANTED; }

  private List<String> missing(String[] perms) {
    List<String> out = new ArrayList<>();
    for (String p : perms) if (!has(p)) out.add(p);
    return out;
  }

  private void handleWebPermission(PermissionRequest req) {
    List<String> need = new ArrayList<>();
    for (String r : req.getResources()) {
      if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r)) need.add(Manifest.permission.RECORD_AUDIO);
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) { need.add(Manifest.permission.CAMERA); need.add(HEADSET_CAMERA); }
    }
    List<String> miss = missing(need.toArray(new String[0]));
    miss.remove(HEADSET_CAMERA); // optional: only exists on Quest
    if (miss.isEmpty()) {
      if (!has(HEADSET_CAMERA) && need.contains(HEADSET_CAMERA)) requestPermissions(new String[]{HEADSET_CAMERA}, REQ_STARTUP);
      grantAllowed(req);
      return;
    }
    if (pending != null) pending.deny();
    pending = req;
    if (need.contains(HEADSET_CAMERA) && !has(HEADSET_CAMERA)) miss.add(HEADSET_CAMERA);
    requestPermissions(miss.toArray(new String[0]), REQ_WEB);
  }

  private void grantAllowed(PermissionRequest req) {
    List<String> ok = new ArrayList<>();
    for (String r : req.getResources()) {
      if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(r) && has(Manifest.permission.RECORD_AUDIO)) ok.add(r);
      if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r) && has(Manifest.permission.CAMERA)) ok.add(r);
    }
    if (ok.isEmpty()) req.deny(); else req.grant(ok.toArray(new String[0]));
  }

  @Override
  public void onRequestPermissionsResult(int code, String[] perms, int[] results) {
    super.onRequestPermissionsResult(code, perms, results);
    if (code == REQ_WEB && pending != null) { grantAllowed(pending); pending = null; }
  }

  private void notifySpoken(String id) {
    runOnUiThread(() -> web.evaluateJavascript("window.questaiSpoken && window.questaiSpoken(" + jsString(id) + ")", null));
  }

  private static String jsString(String s) {
    return "'" + s.replace("\\", "\\\\").replace("'", "\\'") + "'";
  }

  @Override
  public void onBackPressed() {
    web.evaluateJavascript("window.questaiBack ? String(window.questaiBack()) : 'false'", v -> {
      if (v != null && v.contains("true")) return;
      if (web.canGoBack()) web.goBack(); else finish();
    });
  }

  @Override
  protected void onSaveInstanceState(Bundle out) {
    super.onSaveInstanceState(out);
    web.saveState(out);
  }

  @Override
  protected void onDestroy() {
    if (tts != null) tts.shutdown();
    web.destroy();
    super.onDestroy();
  }

  /** Exposed to JavaScript as window.QuestAINative */
  class Bridge {
    @JavascriptInterface public String version() { return BuildConfig.VERSION_NAME; }

    @JavascriptInterface public void openAppSettings() {
      runOnUiThread(() -> {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        startActivity(i);
      });
    }

    @JavascriptInterface public boolean canSpeak() { return ttsReady; }

    @JavascriptInterface public void speak(String text, String lang, String id) {
      if (!ttsReady) { notifySpoken(id); return; }
      Locale loc = "ar".equals(lang) ? new Locale("ar") : Locale.US;
      if (tts.isLanguageAvailable(loc) >= TextToSpeech.LANG_AVAILABLE) tts.setLanguage(loc);
      tts.speak(text, TextToSpeech.QUEUE_ADD, null, id);
    }

    @JavascriptInterface public void stopSpeaking() { if (ttsReady) tts.stop(); }
  }
}
