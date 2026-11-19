package io.github.miqatapp.questai;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Keeps the app allowed to use the microphone while another app is in front.
 * Android only lets a foreground service of type "microphone" keep recording in the background.
 */
public class ListenService extends Service {
  private static final String CHANNEL = "listening";

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm.getNotificationChannel(CHANNEL) == null) {
      nm.createNotificationChannel(new NotificationChannel(CHANNEL, "Quest AI", NotificationManager.IMPORTANCE_LOW));
    }
    PendingIntent open = PendingIntent.getActivity(this, 0,
        new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
        PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    Notification n = new Notification.Builder(this, CHANNEL)
        .setContentTitle("Quest AI")
        .setContentText("يسمعك الحين · Listening")
        .setSmallIcon(android.R.drawable.ic_btn_speak_now)
        .setContentIntent(open)
        .setOngoing(true)
        .build();
    if (Build.VERSION.SDK_INT >= 30) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE);
    else startForeground(1, n);
    return START_NOT_STICKY;
  }

  @Override public IBinder onBind(Intent intent) { return null; }
}
