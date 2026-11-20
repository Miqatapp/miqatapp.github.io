package io.github.miqatapp.questai

import android.content.Context
import android.hardware.camera2.CameraCharacteristics
import android.hardware.camera2.CameraManager
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
import com.meta.spatial.core.Query
import com.meta.spatial.core.SpatialFeature
import com.meta.spatial.core.Vector3
import com.meta.spatial.runtime.ReferenceSpace
import com.meta.spatial.toolkit.AppSystemActivity
import com.meta.spatial.toolkit.AvatarBody
import com.meta.spatial.toolkit.Controller
import com.meta.spatial.toolkit.ControllerType
import com.meta.spatial.toolkit.Grabbable
import com.meta.spatial.toolkit.PanelRegistration
import com.meta.spatial.toolkit.PanelStyleOptions
import com.meta.spatial.toolkit.DpPerMeterDisplayOptions
import com.meta.spatial.toolkit.QuadShapeOptions
import com.meta.spatial.toolkit.Scale
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
  private var uiEntity: Entity? = null
  private var panelScale = 0.62f

  // head poses of the last few seconds, so a box is projected from where the head was when the
  // camera frame was taken (the answer arrives a moment later)
  private val poses = ArrayDeque<Pair<Long, Pose>>()

  private data class Spec(val label: String, val index: Int, val w: Float, val h: Float, val labelM: Float = LABEL_M) {
    /** The panel is at least as wide as the name tag, so long names are never cut. */
    val panelW: Float get() = max(w, (String.format("%02d  %s", index + 1, label).length * 0.34f + 1.2f) * labelM)
  }
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
            // ~1275 x 800 dp layout on a 1.5 m panel, rendered at 1.5x for crisp text
            {
              UIPanelSettings(
                  QuadShapeOptions(1.5f, 0.94f),
                  DpPerMeterDisplayOptions(850f, 1.5f),
                  UIPanelRenderOptions(),
                  PanelStyleOptions(R.style.TransparentPanel))
            }))
    for (i in 0 until SLOTS) {
      val id = BOX_BASE + i
      list +=
          ViewPanelRegistration(
              id,
              { _, ctx -> MarkerView(ctx, specs[id] ?: Spec("", 0, 0.2f, 0.2f)) },
              {
                val s = specs[id] ?: Spec("", 0, 0.2f, 0.2f)
                val h = s.h + s.labelM
                UIPanelSettings(
                    QuadShapeOptions(s.panelW, h),
                    DpPerMeterDisplayOptions(900f, 1.5f),
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
    handHist.addLast(Triple(now, handPose(0), handPose(1)))
    while (handHist.isNotEmpty() && now - handHist.first().first > 5000) handHist.removeFirst()
    // place the assistant panel in front of the user once tracking has a real head pose
    if (!uiPlaced && (pose.t.x != 0f || pose.t.y != 0f || pose.t.z != 0f)) {
      uiPlaced = true
      val flat = pose.removePitchAndRoll()
      // a little below eye level so the room in front stays visible
      val pos = pose.t.plus(flat.forward().times(0.95f)).plus(Vector3(0f, -0.30f, 0f))
      uiEntity = Entity.createPanelEntity(UI_PANEL, Transform(Pose(pos, flat.q)), Grabbable(), Scale(Vector3(panelScale, panelScale, panelScale)))
    }
    // glide every marker toward where the tracker last saw its object (frame-rate independent)
    val dt = ((now - lastTick).coerceIn(1L, 100L)) / 1000f
    lastTick = now
    val a = 1f - kotlin.math.exp(-dt * 16f)
    val head = pose
    for (m in live.values) {
      val anchor = m.anchor
      if (anchor != null) {
        val hp = handPose(anchor.first)
        if (hp != null) { m.target = hp.times(anchor.second).t; m.facing = head; m.handSeen = now }
      }
      val tgt = m.target ?: continue
      val k = if (anchor != null) 1f - kotlin.math.exp(-dt * 40f) else a
      m.pos = m.pos.times(1f - k).plus(tgt.times(k))
      m.sx += (m.tsx - m.sx) * k; m.sy += (m.tsy - m.sy) * k
      m.entity.setComponent(Transform(Pose(m.pos, m.facing.q)))
      m.entity.setComponent(Scale(Vector3(m.sx, m.sy, 1f)))
    }
    // markers fade after a while
    val it = markers.iterator()
    while (it.hasNext()) {
      val (e, born) = it.next()
      if (now - born > MARKER_LIFE_MS) { e.destroy(); it.remove(); live.values.removeAll { m -> m.entity == e } }
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
    live.clear()
  }

  override fun setPanelScale(scale: Float) {
    panelScale = scale.coerceIn(0.4f, 1.6f)
    uiEntity?.setComponent(Scale(Vector3(panelScale, panelScale, panelScale)))
  }

  /** Where a pixel of the camera image points, in "tangent" units (x right, y up) relative to the
   *  camera's optical axis. Uses the camera's real calibration when the system provides it. */
  /** fwd/right/up: the camera's optical axis and image axes in the headset frame (x right, y up, z back);
   *  pos: camera position in that frame (metres). */
  private class Lens(val fx: Float, val fy: Float, val cx: Float, val cy: Float, val sw: Float, val sh: Float, val info: String,
                     val fwd: FloatArray, val right: FloatArray, val up: FloatArray, val pos: FloatArray) {
    fun tan(u: Float, v: Float, w: Float, h: Float): Pair<Float, Float> {
      // the stream is the sensor image scaled (and centre-cropped if the aspect differs)
      val scale = max(w / sw, h / sh)
      val xs = (u * w - w / 2f) / scale + sw / 2f
      val ys = (v * h - h / 2f) / scale + sh / 2f
      return (xs - cx) / fx to -(ys - cy) / fy
    }
  }

  private fun lensFor(label: String): Lens? {
    return try {
      val cm = getSystemService(CameraManager::class.java)
      val id = Regex("camera2 (\\d+)").find(label)?.groupValues?.get(1)
          ?: cm.cameraIdList.firstOrNull { cm.getCameraCharacteristics(it).get(CameraCharacteristics.LENS_FACING) == CameraCharacteristics.LENS_FACING_BACK }
          ?: return null
      val ch = cm.getCameraCharacteristics(id)
      val k = ch.get(CameraCharacteristics.LENS_INTRINSIC_CALIBRATION) ?: return null
      val arr = ch.get(CameraCharacteristics.SENSOR_INFO_PRE_CORRECTION_ACTIVE_ARRAY_SIZE)
          ?: ch.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE) ?: return null
      val q = ch.get(CameraCharacteristics.LENS_POSE_ROTATION) ?: floatArrayOf(0f, 0f, 0f, 1f)
      val tr = ch.get(CameraCharacteristics.LENS_POSE_TRANSLATION) ?: floatArrayOf(0f, 0f, 0f)
      val sw = arr.width().toFloat(); val sh = arr.height().toFloat()
      val hfov = 2 * atan(sw / 2 / k[0]) * 180 / PI
      // LENS_POSE_ROTATION rotates the device frame into the camera frame (camera: x right,
      // y down, z = optical axis). Undo it to get the camera axes in the device frame. If that
      // points backwards, the platform used the opposite convention, so use the other direction.
      var inv = true
      var f = rotate(q, floatArrayOf(0f, 0f, 1f), inv)
      if (f[2] > 0f) { inv = false; f = rotate(q, floatArrayOf(0f, 0f, 1f), inv) }
      var r = rotate(q, floatArrayOf(1f, 0f, 0f), inv)
      var u = rotate(q, floatArrayOf(0f, -1f, 0f), inv)
      if (f[2] > 0f) { f = floatArrayOf(0f, 0f, -1f); r = floatArrayOf(1f, 0f, 0f); u = floatArrayOf(0f, 1f, 0f) }   // still nonsense: assume straight ahead
      if (u[1] < 0f) { r = r.map { -it }.toFloatArray(); u = u.map { -it }.toFloatArray() }                         // image delivered upside down
      val pos = if (kotlin.math.sqrt(tr[0] * tr[0] + tr[1] * tr[1] + tr[2] * tr[2]) < 0.25f) tr else floatArrayOf(0f, 0f, 0f)
      val pitch = Math.toDegrees(kotlin.math.asin(f[1].toDouble().coerceIn(-1.0, 1.0)))
      val yaw = Math.toDegrees(kotlin.math.atan2(f[0].toDouble(), -f[2].toDouble()))
      Lens(k[0], k[1], k[2], k[3], sw, sh,
          "cam $id ${sw.toInt()}x${sh.toInt()} fx=${"%.0f".format(k[0])} hfov=${"%.0f".format(hfov)} pitch=${"%.1f".format(pitch)} yaw=${"%.1f".format(yaw)} " +
              "q=[${q.joinToString(",") { "%.3f".format(it) }}] t=[${tr.joinToString(",") { "%.3f".format(it) }}] inv=$inv",
          f, r, u, pos)
    } catch (e: Exception) { Log.w(WebShell.TAG, "lens", e); null }
  }

  /** How camera-image boxes map to the room for the current stream (kept so tracked boxes can move). */
  private class Frame(val lens: Lens?, val w: Float, val h: Float, val hf: Float, val vf: Float, val offX: Float, val offY: Float)
  private class Marker(val entity: Entity, val born: Long, var dist: Float, val bw0: Float, val bh0: Float, val labelM: Float,
                       var pos: Vector3, var facing: Pose) {
    var target: Vector3? = null
    var sx = 1f; var sy = 1f; var tsx = 1f; var tsy = 1f
    /** Held in a hand: (0 left / 1 right, marker pose in that hand's frame). Follows the hand every frame. */
    var anchor: Pair<Int, Pose>? = null
    var handSeen = 0L
    var disagreeSince = 0L
  }

  // ---- hands (Quest hand tracking): a held object moves exactly with the hand holding it ----
  private var handEntities: List<Entity>? = null
  private fun handPose(side: Int): Pose? = try {
    val hands = handEntities ?: Query.where { has(AvatarBody.id) }.eval()
        .map { it.getComponent<AvatarBody>() }.firstOrNull { it.isPlayerControlled }
        ?.let { listOf(it.leftHand, it.rightHand) }?.also { handEntities = it }
    val h = hands?.getOrNull(side)
    val c = h?.tryGetComponent<Controller>()
    if (h == null || c == null || !c.isActive || c.type != ControllerType.HAND) null
    else h.getComponent<Transform>().transform.takeIf { it.t.x != 0f || it.t.y != 0f || it.t.z != 0f }
  } catch (e: Exception) { null }

  // where the hands were over the last seconds: the answer arrives after the frame was taken,
  // so a held object is matched with (and offset from) the hand as it was in that frame
  private val handHist = ArrayDeque<Triple<Long, Pose?, Pose?>>()
  private fun handAt(side: Int, ageMs: Long): Pose? {
    val t = SystemClock.uptimeMillis() - ageMs
    val e = handHist.minByOrNull { kotlin.math.abs(it.first - t) } ?: return handPose(side)
    return if (side == 0) e.second else e.third
  }

  /** The tracked hand nearest the ray from the eyes through the object: (side, depth along the ray, distance from ray). */
  private fun handOnRay(origin: Vector3, dir: Vector3, ageMs: Long): Triple<Int, Float, Float>? {
    var best: Triple<Int, Float, Float>? = null
    for (side in 0..1) {
      val hp = handAt(side, ageMs) ?: continue
      val v = hp.t.minus(origin); val along = v.dot(dir)
      val perp = v.minus(dir.times(along)).length()
      if (along > 0.15f && along < 1.0f && perp < 0.16f && (best == null || perp < best.third)) best = Triple(side, along, perp)
    }
    return best
  }
  private var lastTick = 0L
  private var frame: Frame? = null
  private val live = HashMap<Int, Marker>()   // box index → marker

  private fun frameFrom(o: JSONObject): Frame {
    val w = o.optDouble("w", 1280.0).toFloat(); val h = o.optDouble("h", 960.0).toFloat()
    val hf = (o.optDouble("fov", 78.0) * PI / 180).toFloat()
    return Frame(lensFor(o.optString("cam")), w, h, hf, 2f * atan(tan(hf / 2f) * h / w),
        tan((o.optDouble("offX", 0.0) * PI / 180).toFloat()), tan((o.optDouble("offY", 0.0) * PI / 180).toFloat()))
  }

  /** Box (0..1000, [ymin,xmin,ymax,xmax]) seen from `head` → marker centre and size at `dist`. */
  private fun aim(f: Frame, a: org.json.JSONArray, dist: Float, head: Pose, labelM: Float): Triple<Vector3, Float, Float> {
    fun tanOf(u: Float, v: Float): Pair<Float, Float> =
        f.lens?.tan(u, v, f.w, f.h) ?: (tan((u - 0.5f) * f.hf) to tan((0.5f - v) * f.vf))
    val fwd = head.forward(); val right = head.right(); val up = head.up()
    fun world(v: FloatArray) = right.times(v[0]).plus(up.times(v[1])).plus(fwd.times(-v[2]))
    val camF = f.lens?.let { world(it.fwd) } ?: fwd
    val camR = f.lens?.let { world(it.right) } ?: right
    val camU = f.lens?.let { world(it.up) } ?: up
    val camPos = f.lens?.let { head.t.plus(world(it.pos)) } ?: head.t
    val y0 = (a.getDouble(0) / 1000).toFloat(); val x0 = (a.getDouble(1) / 1000).toFloat()
    val y1 = (a.getDouble(2) / 1000).toFloat(); val x1 = (a.getDouble(3) / 1000).toFloat()
    val (tx0, ty0) = tanOf(min(x0, x1), min(y0, y1))
    val (tx1, ty1) = tanOf(max(x0, x1), max(y0, y1))
    val tx = (tx0 + tx1) / 2f + f.offX; val ty = (ty0 + ty1) / 2f + f.offY
    val dir = camF.plus(camR.times(tx)).plus(camU.times(ty)).normalize()
    val along = dist / kotlin.math.sqrt(1f + tx * tx + ty * ty)
    val bw = max(0.03f, kotlin.math.abs(tx1 - tx0) * along)
    val bh = max(0.03f, kotlin.math.abs(ty0 - ty1) * along)
    return Triple(camPos.plus(dir.times(dist)).plus(up.times(labelM / 2f)), bw, bh)
  }

  /** json: {boxes:[{label, box:[ymin,xmin,ymax,xmax], dist?}], ageMs, cam, w, h, fov, offX, offY, dist} */
  override fun placeBoxes(json: String) {
    try {
      val o = JSONObject(json)
      val boxes = o.getJSONArray("boxes")
      val age = o.optLong("ageMs", 0)
      val head = poseAt(age)
      val f = frameFrom(o).also { frame = it }
      val defaultDist = o.optDouble("dist", 1.2).toFloat()
      clearBoxes()
      val report = StringBuilder(f.lens?.info ?: "no lens calibration, fov ${o.optDouble("fov", 78.0)}")
      for (i in 0 until min(boxes.length(), SLOTS)) {
        val b = boxes.getJSONObject(i)
        var dist = b.optDouble("dist", defaultDist.toDouble()).toFloat().coerceIn(0.3f, 6f)
        var labelM = (LABEL_M * dist / 1.2f).coerceIn(0.04f, 0.16f)
        var (centre, bw, bh) = aim(f, b.getJSONArray("box"), dist, head, labelM)
        // is it in a hand? then it is as far away as that hand, and it moves with it
        val dir = centre.minus(head.t).normalize()
        val held = handOnRay(head.t, dir, age)
        if (held != null) {
          dist = held.second.coerceIn(0.2f, 1.0f)
          labelM = (LABEL_M * dist / 1.2f).coerceIn(0.04f, 0.16f)
          val again = aim(f, b.getJSONArray("box"), dist, head, labelM)
          centre = again.first; bw = again.second; bh = again.third
        }
        val id = BOX_BASE + (nextSlot++ % SLOTS)
        specs[id] = Spec(b.optString("label"), i, bw, bh, labelM)
        val e = Entity.createPanelEntity(id, Transform(Pose(centre, head.q)))
        val now = SystemClock.uptimeMillis()
        markers += e to now
        val m = Marker(e, now, dist, bw, bh, labelM, centre, head)
        if (held != null) handAt(held.first, age)?.let { hp -> m.anchor = held.first to hp.inverse().times(Pose(centre, head.q)); m.handSeen = now }
        live[i] = m
        report.append(" | ${b.optString("label")} d=${"%.2f".format(dist)} ${"%.2f".format(bw)}x${"%.2f".format(bh)}m" +
            (if (held != null) " in ${if (held.first == 0) "left" else "right"} hand (${"%.0f".format(held.third * 100)}cm off ray)" else " hands: ${listOf(0, 1).count { handAt(it, age) != null }}"))
      }
      shell.js("window.questaiLog && window.questaiLog(" + JSONObject.quote("AR " + report) + ")")
    } catch (e: Exception) {
      Log.w(WebShell.TAG, "placeBoxes", e)
    }
  }

  /** Tracked positions from the live camera: json {boxes:[{i, box}]} — moves the existing markers. */
  override fun moveBoxes(json: String) {
    val f = frame ?: return
    try {
      val boxes = JSONObject(json).getJSONArray("boxes")
      val head = scene.getViewerPose()
      for (k in 0 until boxes.length()) {
        val b = boxes.getJSONObject(k)
        val m = live[b.getInt("i")] ?: continue
        val (centre, bw, bh) = aim(f, b.getJSONArray("box"), m.dist, head, m.labelM)
        if (m.anchor != null) {
          val now = SystemClock.uptimeMillis()
          val seen = centre.minus(head.t).normalize(); val held = m.pos.minus(head.t).normalize()
          if (seen.dot(held) < 0.985f) {          // > ~10° apart: the camera sees it elsewhere
            if (m.disagreeSince == 0L) m.disagreeSince = now
            if (now - m.disagreeSince < 1200) continue
            m.anchor = null; m.dist = m.pos.minus(head.t).length().coerceIn(0.3f, 6f)   // let go: follow the camera again
          } else { m.disagreeSince = 0L; continue }
        }
        // onSceneTick glides there; jumping straight to each update is what made it look jerky
        m.target = centre; m.facing = head
        m.tsx = bw / m.bw0; m.tsy = (bh + m.labelM) / (m.bh0 + m.labelM)
      }
    } catch (e: Exception) {
      Log.w(WebShell.TAG, "moveBoxes", e)
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
      val labelH = H * spec.labelM / (spec.h + spec.labelM)
      val bw = W * spec.w / spec.panelW   // the box is centred; the panel may be wider for the name
      val r = RectF((W - bw) / 2f + 8f, labelH + 8f, (W + bw) / 2f - 8f, H - 8f)
      c.drawRect(r, fill)
      c.drawRect(r, line)
      val L = min(r.width(), r.height()) * 0.25f
      glow.strokeWidth = max(6f, bw / 80f)
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
    /** Rotates v by quaternion q = (x, y, z, w), or by its inverse. */
    private fun rotate(q: FloatArray, v: FloatArray, inverse: Boolean): FloatArray {
      val x = if (inverse) -q[0] else q[0]; val y = if (inverse) -q[1] else q[1]; val z = if (inverse) -q[2] else q[2]; val w = q[3]
      // t = 2 * cross(q.xyz, v); v' = v + w * t + cross(q.xyz, t)
      val tx = 2f * (y * v[2] - z * v[1]); val ty = 2f * (z * v[0] - x * v[2]); val tz = 2f * (x * v[1] - y * v[0])
      return floatArrayOf(
          v[0] + w * tx + (y * tz - z * ty),
          v[1] + w * ty + (z * tx - x * tz),
          v[2] + w * tz + (x * ty - y * tx))
    }

    private const val UI_PANEL = 0x51A1
    private const val BOX_BASE = 0x51B0
    private const val SLOTS = 8
    private const val LABEL_M = 0.07f
    private const val MARKER_LIFE_MS = 45_000L
    private const val LIME = 0xFFD4FF3F.toInt()
  }
}
