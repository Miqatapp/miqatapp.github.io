package io.github.miqatapp.questai

import android.content.Context
import android.graphics.BlurMaskFilter
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Bundle
import android.os.SystemClock
import android.util.Log
import android.view.View
import com.meta.spatial.core.Entity
import com.meta.spatial.core.Pose
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PanelStyleOptions
import com.meta.spatial.toolkit.PixelDisplayOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Transform
import com.meta.spatial.toolkit.UIPanelRenderOptions
import com.meta.spatial.toolkit.UIPanelSettings
import com.meta.spatial.toolkit.ViewPanelRegistration
import com.meta.spatial.toolkit.createPanelEntity
import com.meta.spatial.vr.VRFeature
import org.json.JSONObject
import kotlin.math.PI
import kotlin.math.atan
import kotlin.math.max
import kotlin.math.min
import kotlin.math.tan

/**
 * Headset app: passthrough (you see your room), the assistant UI as a floating panel you can
 * grab and move, and object markers placed in the room where the camera saw the object.
 */
class SpatialActivity : AppSystemActivity(), WebShell.Host {
  private lateinit var shell: WebShell
  private var savedState: Bundle? = null
  private var uiPlaced = false

  // head poses of the last few seconds, so a box is projected from where the head was when the
  // camera frame was taken (the answer arrives a moment later)
  private val poses = ArrayDeque<Pair<Long, Pose>>()

  private data class Spec(val label: String, val index: Int, val w: Float, val h: Float)
  private val specs = HashMap<Int, Spec>()
  private val markers = mutableListOf<Pair<Entity, Long>>()
  private var nextSlot = 0

  override fun onCreate(savedInstanceState: Bundle?) {
    savedState = savedInstanceState
    shell = WebShell(this, this)
    super.onCreate(savedInstanceState)
  }

  override fun registerFeatures(): List<SpatialFeature> = listOf(VRFeature(this))

  override fun registerPanels(): List<PanelRegistration> {
    val list = mutableListOf<PanelRegistration>(
        ViewPanelRegistration(
            UI_PANEL,
            { _, ctx -> shell.create(ctx, savedState) },
            { UIPanelSettings(QuadShapeOptions(1.5f, 0.94f), PixelDisplayOptions(1500, 940)) }))
    for (i in 0 until SLOTS) {
      val id = BOX_BASE + i
      list +=
          ViewPanelRegistration(
              id,
              { _, ctx -> MarkerView(ctx, specs[id] ?: Spec("", 0, 0.2f, 0.2f)) },
              {
                val s = specs[id] ?: Spec("", 0, 0.2f, 0.2f)
                val h = s.h + LABEL_M
                UIPanelSettings(
                    QuadShapeOptions(s.w, h),
                    PixelDisplayOptions(px(s.w), px(h)),
                    UIPanelRenderOptions(),
                    PanelStyleOptions(R.style.TransparentPanel))
              })
    }
    return list
  }

  override fun onSceneReady() {
    super.onSceneReady()
    scene.setReferenceSpace(ReferenceSpace.LOCAL_FLOOR)
    scene.enablePassthrough(true)
  }

  override fun onSceneTick() {
    super.onSceneTick()
    val pose = scene.getViewerPose()
    val now = SystemClock.uptimeMillis()
    poses.addLast(now to pose)
    while (poses.isNotEmpty() && now - poses.first().first > 5000) poses.removeFirst()
    // place the assistant panel in front of the user once tracking has a real head pose
    if (!uiPlaced && (pose.t.x != 0f || pose.t.y != 0f || pose.t.z != 0f)) {
      uiPlaced = true
      val flat = pose.removePitchAndRoll()
      val pos = pose.t.plus(flat.forward().times(1.05f)).plus(Vector3(0f, -0.12f, 0f))
      Entity.createPanelEntity(UI_PANEL, Transform(Pose(pos, flat.q)), Grabbable())
    }
    // markers fade after a while
    val it = markers.iterator()
    while (it.hasNext()) {
      val (e, born) = it.next()
      if (now - born > MARKER_LIFE_MS) { e.destroy(); it.remove() }
    }
  }

  private fun poseAt(ageMs: Long): Pose {
    val t = SystemClock.uptimeMillis() - ageMs
    return poses.minByOrNull { kotlin.math.abs(it.first - t) }?.second ?: scene.getViewerPose()
  }

  // ---- WebShell.Host ----
  override fun isSpatial() = true

  override fun clearBoxes() {
    markers.forEach { it.first.destroy() }
    markers.clear()
  }

  /** json: {boxes:[{label, box:[ymin,xmin,ymax,xmax]}], ageMs, fov, offX, offY, aspect, dist} */
  override fun placeBoxes(json: String) {
    try {
      val o = JSONObject(json)
      val boxes = o.getJSONArray("boxes")
      val head = poseAt(o.optLong("ageMs", 0))
      val hf = (o.optDouble("fov", 78.0) * PI / 180).toFloat()
      val aspect = o.optDouble("aspect", 4.0 / 3.0).toFloat()
      val vf = 2f * atan(tan(hf / 2f) / aspect)
      val offX = (o.optDouble("offX", 0.0) * PI / 180).toFloat()
      val offY = (o.optDouble("offY", 0.0) * PI / 180).toFloat()
      val dist = o.optDouble("dist", 0.9).toFloat()
      clearBoxes()
      val fwd = head.forward(); val right = head.right(); val up = head.up()
      for (i in 0 until min(boxes.length(), SLOTS)) {
        val b = boxes.getJSONObject(i)
        val a = b.getJSONArray("box")
        val y0 = (a.getDouble(0) / 1000).toFloat(); val x0 = (a.getDouble(1) / 1000).toFloat()
        val y1 = (a.getDouble(2) / 1000).toFloat(); val x1 = (a.getDouble(3) / 1000).toFloat()
        val cx = (x0 + x1) / 2f; val cy = (y0 + y1) / 2f
        val bw = kotlin.math.abs(x1 - x0); val bh = kotlin.math.abs(y1 - y0)
        // ray from the eye through the box centre
        val ax = tan((cx - 0.5f) * hf + offX); val ay = tan((0.5f - cy) * vf + offY)
        val dir = fwd.plus(right.times(ax)).plus(up.times(ay)).normalize()
        val w = max(0.04f, 2f * dist * tan(hf / 2f) * bw)
        val h = max(0.04f, 2f * dist * tan(vf / 2f) * bh)
        val id = BOX_BASE + (nextSlot++ % SLOTS)
        specs[id] = Spec(b.optString("label"), i, w, h)
        // panel centre is above the box centre by half the label strip
        val centre = head.t.plus(dir.times(dist)).plus(up.times(LABEL_M / 2f))
        val e = Entity.createPanelEntity(id, Transform(Pose(centre, head.q)))
        markers += e to SystemClock.uptimeMillis()
      }
    } catch (e: Exception) {
      Log.w(WebShell.TAG, "placeBoxes", e)
    }
  }

  override fun onRequestPermissionsResult(code: Int, perms: Array<String>, results: IntArray) {
    super.onRequestPermissionsResult(code, perms, results)
    shell.onPermissionsResult(code)
  }

  override fun onSaveInstanceState(out: Bundle) {
    super.onSaveInstanceState(out)
    shell.save(out)
  }

  override fun onDestroy() {
    shell.destroy()
    super.onDestroy()
  }

  /** Glowing corner brackets around the object and a lime name tag above it. */
  private class MarkerView(ctx: Context, private val spec: Spec) : View(ctx) {
    private val glow = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = LIME; style = Paint.Style.STROKE; strokeCap = Paint.Cap.SQUARE
      maskFilter = BlurMaskFilter(10f, BlurMaskFilter.Blur.SOLID)
    }
    private val line = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = 0x66D4FF3F; style = Paint.Style.STROKE; strokeWidth = 3f }
    private val fill = Paint().apply { color = 0x1FD4FF3F }
    private val tag = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = LIME }
    private val text = Paint(Paint.ANTI_ALIAS_FLAG).apply {
      color = 0xFF0E1200.toInt(); typeface = Typeface.DEFAULT_BOLD; textAlign = Paint.Align.CENTER
    }

    init { setBackgroundColor(Color.TRANSPARENT); setLayerType(LAYER_TYPE_SOFTWARE, null) }

    override fun onDraw(c: Canvas) {
      val W = width.toFloat(); val H = height.toFloat()
      val labelH = H * LABEL_M / (spec.h + LABEL_M)
      val r = RectF(8f, labelH + 8f, W - 8f, H - 8f)
      c.drawRect(r, fill)
      c.drawRect(r, line)
      val L = min(r.width(), r.height()) * 0.25f
      glow.strokeWidth = max(6f, W / 80f)
      for ((x, y, dx, dy) in listOf(
          floatArrayOf(r.left, r.top, 1f, 1f), floatArrayOf(r.right, r.top, -1f, 1f),
          floatArrayOf(r.left, r.bottom, 1f, -1f), floatArrayOf(r.right, r.bottom, -1f, -1f))) {
        c.drawLine(x, y, x + dx * L, y, glow)
        c.drawLine(x, y, x, y + dy * L, glow)
      }
      // centre tick
      val cx = r.centerX(); val cy = r.centerY(); val k = min(W, H) * 0.03f
      c.drawLine(cx - k, cy, cx + k, cy, line); c.drawLine(cx, cy - k, cx, cy + k, line)
      // name tag
      val label = String.format("%02d  %s", spec.index + 1, spec.label)
      text.textSize = labelH * 0.58f
      val tw = min(W, text.measureText(label) + labelH)
      val tag = RectF((W - tw) / 2f, 4f, (W + tw) / 2f, labelH - 4f)
      c.drawRoundRect(tag, labelH * 0.3f, labelH * 0.3f, this.tag)
      c.drawText(label, W / 2f, tag.centerY() + text.textSize * 0.35f, text)
    }
  }

  companion object {
    private const val UI_PANEL = 0x51A1
    private const val BOX_BASE = 0x51B0
    private const val SLOTS = 8
    private const val LABEL_M = 0.07f
    private const val MARKER_LIFE_MS = 45_000L
    private const val LIME = 0xFFD4FF3F.toInt()
    private fun px(m: Float) = max(64, (m * 900).toInt())
  }
}
