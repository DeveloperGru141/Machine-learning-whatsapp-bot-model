import os
import math
import subprocess
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from scipy.ndimage import binary_fill_holes, binary_closing, gaussian_filter

# Configuration
WIDTH = 720
HEIGHT = 1280
FPS = 30
TOTAL_FRAMES = 150  # 5.0 seconds
TEMP_DIR = r"C:\Users\ADEMOLA\.gemini\antigravity\scratch\whatsapp-modular-bot\data\temp\motion_frames"
OUTPUT_MP4 = r"C:\Users\ADEMOLA\.gemini\antigravity\scratch\whatsapp-modular-bot\assets\status_motion_design.mp4"
OUTPUT_GIF = r"C:\Users\ADEMOLA\.gemini\antigravity\scratch\whatsapp-modular-bot\assets\status_motion_design.gif"
ARTIFACT_DIR = r"C:\Users\ADEMOLA\.gemini\antigravity\brain\bedc8cb6-fd46-484d-b8a9-79430d540bd9"
SOURCE_IMG_PATH = r"C:\Users\ADEMOLA\.gemini\antigravity\brain\bedc8cb6-fd46-484d-b8a9-79430d540bd9\.user_uploaded\media_1792457555586_10beea4e.png"
FFMPEG_PATH = r"C:\Users\ADEMOLA\.gemini\antigravity\scratch\whatsapp-modular-bot\node_modules\ffmpeg-static\ffmpeg.exe"

os.makedirs(TEMP_DIR, exist_ok=True)
os.makedirs(os.path.dirname(OUTPUT_MP4), exist_ok=True)

print("[1/5] Loading source image & segmenting red panda avatar...")
src_im = Image.open(SOURCE_IMG_PATH).convert('RGB')
arr = np.array(src_im)

is_face = (arr[:, :, 0] > 120) & (arr[:, :, 1] > 35) & (arr[:, :, 1] < 140) & (arr[:, :, 2] < 100)
is_white = (arr[:, :, 0] > 170) & (arr[:, :, 1] > 155) & (arr[:, :, 2] > 130)
is_dark = (arr[:, :, 0] < 55) & (arr[:, :, 1] < 55) & (arr[:, :, 2] < 55) & (arr[:, :, 0] + arr[:, :, 1] + arr[:, :, 2] < 140)

char_mask = is_face | is_white | is_dark
y_grid, x_grid = np.ogrid[:arr.shape[0], :arr.shape[1]]
center_dist = np.sqrt((x_grid - 118)**2 + (y_grid - 138)**2)
char_mask = char_mask & (center_dist < 118)

char_mask = binary_fill_holes(char_mask)
char_mask = binary_closing(char_mask, iterations=3)

smooth_mask = gaussian_filter(char_mask.astype(float), sigma=0.8)
alpha = (np.clip(smooth_mask * 280, 0, 255)).astype(np.uint8)

base_avatar = Image.fromarray(np.dstack([arr, alpha]))

# Generate open eye state and winking eye states
print("[2/5] Creating avatar animation states (open eye, wink stages)...")
face_color = (170, 86, 50, 255)
eyebrow_color = (235, 225, 215, 255)
dark_eye_color = (25, 20, 24, 255)

def get_avatar_frame(wink_t=0.0):
    """
    wink_t: 0.0 = fully open, 1.0 = fully closed wink arc
    """
    av = base_avatar.copy()
    draw = ImageDraw.Draw(av)
    
    if wink_t > 0.05:
        # Erase eye area with face color
        draw.ellipse([94, 149, 120, 173], fill=face_color)
        
        # Eyebrow dipping down slightly
        dip = int(wink_t * 6)
        draw.rectangle([86, 122, 117, 140], fill=face_color)
        draw.rounded_rectangle([88, 125 + dip, 115, 137 + dip], radius=5, fill=eyebrow_color)
        
        if wink_t < 0.7:
            # Squashing pupil down
            h_rad = int(9 * (1.0 - wink_t * 0.9))
            draw.ellipse([98, 161 - h_rad, 116, 161 + h_rad], fill=dark_eye_color)
        else:
            # Fully closed happy wink arc: ⌒
            draw.arc([96, 153, 118, 169], start=190, end=350, fill=dark_eye_color, width=4)
            # Subtle eyelash flick
            draw.line([(117, 161), (122, 157)], fill=dark_eye_color, width=3)
            draw.line([(118, 163), (122, 163)], fill=dark_eye_color, width=3)
    
    return av

# Pre-generate starry galaxy background
print("[3/5] Generating cinematic galaxy & nebula background...")
np.random.seed(42)
num_stars = 180
stars_x = np.random.randint(10, WIDTH - 10, num_stars)
stars_y = np.random.randint(10, HEIGHT - 10, num_stars)
stars_size = np.random.choice([1, 2, 3], size=num_stars, p=[0.75, 0.20, 0.05])
stars_speed = np.random.uniform(0.05, 0.2, num_stars)
stars_phase = np.random.uniform(0, 2 * math.pi, num_stars)

def create_background(frame_idx):
    bg = Image.new('RGB', (WIDTH, HEIGHT), color=(11, 14, 27))
    draw = ImageDraw.Draw(bg)
    
    # Smooth vertical gradient (deep space navy -> mystical cosmic purple/magenta -> midnight abyss)
    for y in range(0, HEIGHT, 2):
        t = y / HEIGHT
        if t < 0.45:
            # Navy to deep indigo
            ratio = t / 0.45
            r = int(10 + ratio * 20)
            g = int(14 + ratio * 10)
            b = int(28 + ratio * 45)
        elif t < 0.75:
            # Indigo to dark magenta / cosmic amber
            ratio = (t - 0.45) / 0.30
            r = int(30 + ratio * 45)
            g = int(24 + ratio * 15)
            b = int(73 - ratio * 25)
        else:
            # Dark amber to midnight abyss
            ratio = (t - 0.75) / 0.25
            r = int(75 - ratio * 60)
            g = int(39 - ratio * 25)
            b = int(48 - ratio * 32)
        draw.rectangle([(0, y), (WIDTH, y + 2)], fill=(r, g, b))
    
    # Draw twinkling stars
    for i in range(num_stars):
        sx = stars_x[i]
        sy = stars_y[i]
        s_sz = stars_size[i]
        twinkle = 0.5 + 0.5 * math.sin(frame_idx * stars_speed[i] + stars_phase[i])
        brightness = int(130 + 125 * twinkle)
        star_color = (brightness, int(brightness * 0.95), int(brightness * 0.98))
        if s_sz == 1:
            draw.point((sx, sy), fill=star_color)
        else:
            draw.ellipse([sx - s_sz, sy - s_sz, sx + s_sz, sy + s_sz], fill=star_color)
            
    return bg

# Fonts
font_title = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 60)
font_subtitle = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 30)
font_badge = ImageFont.truetype(r"C:\Windows\Fonts\segoeuib.ttf", 18)
font_byline = ImageFont.truetype(r"C:\Windows\Fonts\segoeui.ttf", 20)

def draw_sparkle(draw, cx, cy, size, alpha=1.0):
    if size <= 1 or alpha <= 0:
        return
    r = int(size)
    c = (255, 245, 180, int(255 * alpha))
    glow_c = (255, 200, 80, int(120 * alpha))
    draw.ellipse([cx - r*1.5, cy - r*1.5, cx + r*1.5, cy + r*1.5], fill=glow_c)
    # 4-point star
    draw.polygon([(cx, cy - r*2), (cx + r*0.4, cy), (cx, cy + r*2), (cx - r*0.4, cy)], fill=c)
    draw.polygon([(cx - r*2, cy), (cx, cy + r*0.4), (cx + r*2, cy), (cx, cy - r*0.4)], fill=c)

print("[4/5] Rendering 150 animation frames...")

for frame in range(TOTAL_FRAMES):
    bg = create_background(frame)
    
    # ---------------------------------------------
    # 1. Avatar Position & State Calculation
    # ---------------------------------------------
    # Default center
    avatar_center_x = WIDTH // 2
    avatar_center_y = 600
    avatar_scale = 1.45
    head_tilt = 0.0
    wink_val = 0.0
    sparkle_size = 0.0
    
    # Breathing float
    float_offset = 12 * math.sin(frame * 0.08)
    
    if frame < 32:
        # Idle gaze
        avatar_center_y = 600 + float_offset
    elif frame < 65:
        # Winking phase (Frames 32 - 64)
        avatar_center_y = 600 + float_offset
        wink_progress = (frame - 32) / 32.0  # 0.0 to 1.0
        if wink_progress < 0.25:
            # Closing
            wink_val = wink_progress / 0.25
            head_tilt = -2.5 * wink_val
        elif wink_progress < 0.70:
            # Fully winked
            wink_val = 1.0
            head_tilt = -3.0
            # Sparkle burst
            sparkle_progress = (wink_progress - 0.25) / 0.45
            sparkle_size = 18 * math.sin(sparkle_progress * math.pi)
        else:
            # Opening
            open_prog = (wink_progress - 0.70) / 0.30
            wink_val = 1.0 - open_prog
            head_tilt = -3.0 * (1.0 - open_prog)
    elif frame < 95:
        # Transition & glide upward (Frames 65 - 94)
        t_prog = (frame - 65) / 29.0
        # Smooth ease-in-out curve
        ease = 0.5 - 0.5 * math.cos(t_prog * math.pi)
        avatar_center_y = (600 + float_offset) * (1.0 - ease) + 380 * ease
        avatar_scale = 1.45 * (1.0 - ease) + 1.25 * ease
        head_tilt = 0.0
        wink_val = 0.0
    else:
        # Logo lockup display (Frames 95 - 149)
        avatar_center_y = 380 + 5 * math.sin(frame * 0.06)
        avatar_scale = 1.25
        head_tilt = 0.0
        wink_val = 0.0

    # Render Avatar
    av_frame = get_avatar_frame(wink_val)
    if head_tilt != 0.0:
        av_frame = av_frame.rotate(head_tilt, resample=Image.BICUBIC, expand=True)
    
    # Scale avatar
    target_w = int(249 * avatar_scale)
    target_h = int(248 * avatar_scale)
    av_scaled = av_frame.resize((target_w, target_h), Image.LANCZOS)
    
    # Render soft rim-glow around avatar
    glow_box = Image.new('RGBA', (target_w + 60, target_h + 60), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_box)
    glow_color = (0, 245, 212, 45) if frame >= 65 else (255, 160, 50, 35)
    glow_draw.ellipse([20, 20, target_w + 40, target_h + 40], fill=glow_color)
    glow_box = glow_box.filter(ImageFilter.GaussianBlur(16))
    
    pos_x = int(avatar_center_x - target_w // 2)
    pos_y = int(avatar_center_y - target_h // 2)
    
    bg.paste(glow_box, (pos_x - 30, pos_y - 30), glow_box)
    bg.paste(av_scaled, (pos_x, pos_y), av_scaled)
    
    # Sparkle on wink
    if sparkle_size > 1.0:
        sparkle_img = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
        s_draw = ImageDraw.Draw(sparkle_img)
        sparkle_x = pos_x + int(target_w * 0.58)
        sparkle_y = pos_y + int(target_h * 0.62)
        draw_sparkle(s_draw, sparkle_x, sparkle_y, sparkle_size, alpha=min(1.0, sparkle_size/12.0))
        bg.paste(sparkle_img, (0, 0), sparkle_img)

    # ---------------------------------------------
    # 2. Typography & Motion Graphic Transition
    # ---------------------------------------------
    if frame >= 75:
        alpha_t = min(1.0, (frame - 75) / 25.0)  # 0 to 1
        text_layer = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
        t_draw = ImageDraw.Draw(text_layer)
        
        # Position of texts
        base_text_y = int(660 - 20 * (1.0 - alpha_t))  # upward drift
        
        # Shimmer effect position across text
        shimmer_t = max(0.0, min(1.0, (frame - 95) / 45.0))
        shimmer_x = int(WIDTH * 0.2 + shimmer_t * WIDTH * 0.6)
        
        # "FORGELABS"
        title_text = "FORGELABS"
        title_bbox = font_title.getbbox(title_text)
        title_w = title_bbox[2] - title_bbox[0]
        title_x = (WIDTH - title_w) // 2
        title_y = base_text_y
        
        # Neon Drop Glow
        glow_alpha = int(90 * alpha_t)
        for offset in [(0, 2), (2, 0), (-2, 0), (0, -2)]:
            t_draw.text((title_x + offset[0], title_y + offset[1]), title_text, font=font_title, fill=(0, 245, 212, glow_alpha))
            
        # Title Main Color: Pure crisp white with cyan edge
        title_col = (255, 255, 255, int(255 * alpha_t))
        t_draw.text((title_x, title_y), title_text, font=font_title, fill=title_col)
        
        # "ASSISTANT"
        sub_text = "A S S I S T A N T"
        sub_bbox = font_subtitle.getbbox(sub_text)
        sub_w = sub_bbox[2] - sub_bbox[0]
        sub_x = (WIDTH - sub_w) // 2
        sub_y = title_y + 80
        
        # Golden-Amber glow for ASSISTANT
        sub_col = (255, 183, 3, int(245 * alpha_t))
        t_draw.text((sub_x, sub_y), sub_text, font=font_subtitle, fill=sub_col)
        
        # Pill Container Badge: "YOUR INTELLIGENT WHATSAPP COMPANION"
        if frame >= 90:
            badge_alpha = min(1.0, (frame - 90) / 20.0)
            badge_text = "YOUR INTELLIGENT WHATSAPP COMPANION"
            badge_bbox = font_badge.getbbox(badge_text)
            badge_w = badge_bbox[2] - badge_bbox[0]
            badge_x = (WIDTH - badge_w) // 2
            badge_y = sub_y + 75
            
            pill_pad_x = 24
            pill_pad_y = 10
            pill_box = [
                badge_x - pill_pad_x,
                badge_y - pill_pad_y,
                badge_x + badge_w + pill_pad_x,
                badge_y + 22 + pill_pad_y
            ]
            
            # Badge pill background & border
            t_draw.rounded_rectangle(pill_box, radius=20, fill=(20, 30, 50, int(160 * badge_alpha)), outline=(0, 245, 212, int(150 * badge_alpha)), width=2)
            t_draw.text((badge_x, badge_y), badge_text, font=font_badge, fill=(200, 240, 255, int(240 * badge_alpha)))
            
            # Byline at bottom
            byline_text = "Built by Ademola • Online 24/7"
            byline_bbox = font_byline.getbbox(byline_text)
            byline_w = byline_bbox[2] - byline_bbox[0]
            byline_x = (WIDTH - byline_w) // 2
            byline_y = badge_y + 65
            t_draw.text((byline_x, byline_y), byline_text, font=font_byline, fill=(150, 175, 205, int(200 * badge_alpha)))
            
        # Shimmer glint across logo
        if 95 <= frame <= 140:
            shimmer_surf = Image.new('RGBA', (WIDTH, HEIGHT), (0, 0, 0, 0))
            s_draw = ImageDraw.Draw(shimmer_surf)
            s_draw.line([(shimmer_x - 30, title_y - 20), (shimmer_x + 30, sub_y + 40)], fill=(255, 255, 255, 120), width=8)
            shimmer_surf = shimmer_surf.filter(ImageFilter.GaussianBlur(6))
            text_layer = Image.alpha_composite(text_layer, shimmer_surf)

        bg.paste(text_layer, (0, 0), text_layer)
        
    # Save frame
    frame_path = os.path.join(TEMP_DIR, f"frame_{frame:04d}.png")
    bg.save(frame_path)
    if frame % 30 == 0:
        print(f"  Frame {frame}/{TOTAL_FRAMES} rendered ({frame*100//TOTAL_FRAMES}%)...")

print(f"[4/5] All {TOTAL_FRAMES} frames rendered successfully!")

# ---------------------------------------------
# 5. FFmpeg Video Encoding (MP4 & GIF)
# ---------------------------------------------
print("[5/5] Encoding high-definition MP4 with FFmpeg...")
frame_pattern = os.path.join(TEMP_DIR, "frame_%04d.png")

# Generate MP4
ffmpeg_cmd = [
    FFMPEG_PATH,
    "-y",
    "-framerate", str(FPS),
    "-i", frame_pattern,
    "-c:v", "libx264",
    "-profile:v", "high",
    "-level", "4.0",
    "-pix_fmt", "yuv420p",
    "-crf", "18",
    "-preset", "slow",
    "-movflags", "+faststart",
    OUTPUT_MP4
]

res = subprocess.run(ffmpeg_cmd, capture_output=True, text=True)
if res.returncode == 0 and os.path.exists(OUTPUT_MP4):
    mp4_size = os.path.getsize(OUTPUT_MP4)
    print(f"✅ Success! MP4 created at {OUTPUT_MP4} ({mp4_size:,} bytes)")
else:
    print("❌ FFmpeg error:", res.stderr)

# Also generate a GIF preview for instant browser/chat viewing
print("Generating GIF preview...")
gif_cmd = [
    FFMPEG_PATH,
    "-y",
    "-i", OUTPUT_MP4,
    "-vf", "fps=15,scale=360:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
    OUTPUT_GIF
]
subprocess.run(gif_cmd, capture_output=True)
if os.path.exists(OUTPUT_GIF):
    print(f"✅ Success! GIF preview created at {OUTPUT_GIF} ({os.path.getsize(OUTPUT_GIF):,} bytes)")

# Copy to artifact dir so we can link it
art_gif = os.path.join(ARTIFACT_DIR, "status_motion_design.gif")
art_mp4 = os.path.join(ARTIFACT_DIR, "status_motion_design.mp4")
try:
    import shutil
    shutil.copyfile(OUTPUT_GIF, art_gif)
    shutil.copyfile(OUTPUT_MP4, art_mp4)
    print(f"✅ Copied outputs to artifact directory: {art_gif}")
except Exception as e:
    print("Copy note:", e)

# Cleanup temp frames
try:
    for f in os.listdir(TEMP_DIR):
        os.remove(os.path.join(TEMP_DIR, f))
    os.rmdir(TEMP_DIR)
except Exception:
    pass

print("🎉 Motion design generation complete!")
