"""Buracle Stack launch film score: an original 55 s track synthesized from code (released as CC0 with the film).

120 BPM in A minor, one beat = 0.5 s, one chord per bar. The sections follow the beat sheet of index.html, so every
scene change lands on a beat and the big moments get their own musical event, with room between them:

  0.0  intro: half-time kick and 8th hats for one bar, then four on the floor, 16th hats and an opening arp;
       a noise riser from 4.0 and a snare roll from 5.0 build to 6.0
  6.0  drop (the logos lock onto the layer): crash, sub boom, full groove with sidechained supersaw chords
  9.0  memory: half-time groove, 8th arp and hats (the calm part), crash
 14.5  knowledge graph: four on the floor, 8th arp and the counter line; a crash where the search starts (19.5)
 24.5  workflows: arp up an octave in 16ths; the bass rests for one beat before 28.5 (VERIFIED: crash and boom)
 32.5  MCP servers: crash, counter line, 8th arp
 38.0  guards: bass out, chords and arp filtered down, kick stays
 43.0  and more: the groove comes back with 16ths for the feature cards; riser from 47.0, snare build to 49.5
 49.5  end card: second drop on the wordmark slam, full groove to 53.0, then one held chord that rings to 55.0

Usage: python3 score.py <out.wav>   (needs numpy and scipy; deterministic, seeded noise)
"""
import sys
import numpy as np
from scipy import signal

SR = 48000
BPM = 120.0
BEAT = 60.0 / BPM
DUR = 55.0
N = int(SR * DUR)
rng = np.random.default_rng(20261118)

L = np.zeros(N)
R = np.zeros(N)
SENDS = {"verb": [np.zeros(N), np.zeros(N)], "delay": [np.zeros(N), np.zeros(N)]}


def idx(t):
    return int(round(t * SR))


def add(buf_l, buf_r, t, x, gain=1.0, pan=0.0):
    """Mix mono x into a stereo pair at time t with constant-power pan (-1 left .. 1 right)."""
    i = idx(t)
    if i >= N:
        return
    x = x[: N - i] * gain
    a = (pan + 1) * np.pi / 4
    buf_l[i : i + len(x)] += x * np.cos(a)
    buf_r[i : i + len(x)] += x * np.sin(a)


def out(t, x, gain=1.0, pan=0.0, verb=0.0, delay=0.0):
    add(L, R, t, x, gain, pan)
    if verb:
        add(*SENDS["verb"], t, x, gain * verb, pan)
    if delay:
        add(*SENDS["delay"], t, x, gain * delay, pan)


def env(n, a, d, sustain=0.0, curve=1.0):
    """Attack (s) then exponential-ish decay (s) towards sustain."""
    tt = np.arange(n) / SR
    att = np.clip(tt / max(a, 1e-4), 0, 1)
    dec = sustain + (1 - sustain) * np.exp(-np.maximum(tt - a, 0) / max(d, 1e-4)) ** curve
    return att * dec


def saw(freq, n, phase=0.0):
    """Band-limited sawtooth (polyBLEP)."""
    dt = freq / SR
    p = (phase + dt * np.arange(n)) % 1.0
    y = 2 * p - 1
    m1 = p < dt
    x = p[m1] / dt
    y[m1] -= x + x - x * x - 1
    m2 = p > 1 - dt
    x = (p[m2] - 1) / dt
    y[m2] -= x * x + x + x + 1
    return y


def lp(x, fc, order=2):
    fc = min(fc, SR * 0.45)
    return signal.sosfilt(signal.butter(order, fc, "low", fs=SR, output="sos"), x)


def hp(x, fc, order=2):
    return signal.sosfilt(signal.butter(order, fc, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi, order=2):
    return signal.sosfilt(signal.butter(order, [lo, min(hi, SR * 0.45)], "band", fs=SR, output="sos"), x)


def noise(n):
    return rng.standard_normal(n)


def hz(note):
    """MIDI note number to Hz."""
    return 440.0 * 2 ** ((note - 69) / 12)


# ---------------------------------------------------------------- instruments
def kick(t, g=1.0):
    n = idx(0.42)
    tt = np.arange(n) / SR
    f = 48 + 120 * np.exp(-tt / 0.028)
    ph = 2 * np.pi * np.cumsum(f) / SR
    body = np.sin(ph) * env(n, 0.001, 0.17)
    click = hp(noise(n), 2500) * env(n, 0.0005, 0.006) * 0.35
    out(t, np.tanh(1.6 * (body + click)) * 0.9, g)


def clap(t, g=1.0):
    n = idx(0.35)
    x = np.zeros(n)
    for k, off in enumerate((0.0, 0.011, 0.022)):
        i = idx(off)
        m = n - i
        x[i:] += noise(m) * env(m, 0.0005, 0.012 if k < 2 else 0.11)
    x = bp(x, 900, 4200)
    out(t, x * 0.9, g, verb=0.35)


def snare(t, g=1.0):
    n = idx(0.2)
    tt = np.arange(n) / SR
    tone = np.sin(2 * np.pi * 190 * tt) * env(n, 0.001, 0.05)
    x = bp(noise(n), 1500, 9000) * env(n, 0.001, 0.08) + 0.5 * tone
    out(t, x * 0.5, g, verb=0.25)


def hat(t, g=1.0, open_=False, pan=0.0):
    n = idx(0.32 if open_ else 0.06)
    x = hp(noise(n), 7500, 4) * env(n, 0.0008, 0.11 if open_ else 0.018)
    out(t, x * 0.32, g, pan=pan)


def crash(t, g=1.0):
    n = idx(2.4)
    x = hp(noise(n), 3500, 2) * env(n, 0.002, 0.7)
    xr = hp(noise(n), 3500, 2) * env(n, 0.002, 0.7)
    i = idx(t)
    m = min(n, N - i)
    L[i : i + m] += x[:m] * 0.26 * g
    R[i : i + m] += xr[:m] * 0.26 * g


def boom(t, g=1.0):
    n = idx(1.4)
    tt = np.arange(n) / SR
    f = 34 + 40 * np.exp(-tt / 0.15)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, 0.002, 0.55)
    out(t, np.tanh(1.3 * x) * 0.75, g)


def riser(t0, t1, g=1.0):
    n = idx(t1 - t0)
    x = noise(n)
    out_ = np.zeros(n)
    blocks = 64
    edges = np.linspace(0, n, blocks + 1).astype(int)
    for b in range(blocks):
        a, e = edges[b], edges[b + 1]
        k = (b + 0.5) / blocks
        fc = 400 * (12000 / 400) ** k
        out_[a:e] = bp(x[a:e], fc * 0.7, fc * 1.4, 1)
    amp = np.linspace(0, 1, n) ** 2.2
    out(t0, out_ * amp * 0.5, g, verb=0.3)


def bass_note(t, note, length, cutoff, g=1.0):
    n = idx(length)
    f = hz(note)
    x = saw(f, n) + 0.6 * np.sin(2 * np.pi * f / 2 * np.arange(n) / SR)
    x = lp(x, cutoff, 2) * env(n, 0.004, length * 0.55, sustain=0.25)
    out(t, np.tanh(1.4 * x) * 0.5, g)


def pad_chord(t, notes, length, cutoff, g=1.0, pumps=()):
    n = idx(length)
    yl = np.zeros(n)
    yr = np.zeros(n)
    for note in notes:
        f = hz(note)
        for d in (-0.13, -0.07, -0.025, 0.0, 0.03, 0.08, 0.14):
            v = saw(f * 2 ** (d / 12), n, phase=rng.random())
            pan = d / 0.14
            a = (pan + 1) * np.pi / 4
            yl += v * np.cos(a)
            yr += v * np.sin(a)
    shape = env(n, 0.012, length * 0.9, sustain=0.55)
    # sidechain pump: duck after every kick inside the chord
    tt = np.arange(n) / SR
    pump = np.ones(n)
    for k in pumps:
        dtk = tt - (k - t)
        m = dtk >= 0
        pump[m] = np.minimum(pump[m], 1 - 0.78 * np.exp(-dtk[m] / 0.11))
    scale = 0.16 * g / max(1, len(notes))
    yl = lp(yl, cutoff, 2) * shape * pump * scale * 3
    yr = lp(yr, cutoff, 2) * shape * pump * scale * 3
    i = idx(t)
    m = min(n, N - i)
    L[i : i + m] += yl[:m]
    R[i : i + m] += yr[:m]
    SENDS["verb"][0][i : i + m] += yl[:m] * 0.3
    SENDS["verb"][1][i : i + m] += yr[:m] * 0.3


def pluck(t, note, cutoff, g=1.0, pan=0.0):
    n = idx(0.28)
    f = hz(note)
    x = saw(f, n) * 0.6 + np.sign(np.sin(2 * np.pi * f * np.arange(n) / SR)) * 0.25
    tt = np.arange(n) / SR
    # filter envelope: bright attack, quick close
    bright = lp(x, min(cutoff * 2.2, 16000), 2)
    dark = lp(x, cutoff * 0.5, 2)
    w = np.exp(-tt / 0.05)
    x = (bright * w + dark * (1 - w)) * env(n, 0.002, 0.09)
    out(t, x * 0.5, g, pan=pan, verb=0.2, delay=0.32)


# ---------------------------------------------------------------- arrangement
# progression, one bar (four beats) per chord: Am, F, C, G (roots and voicings as MIDI notes)
CHORDS = [
    (45, [57, 60, 64, 69]),  # Am
    (41, [57, 60, 65, 69]),  # F
    (48, [55, 60, 64, 67]),  # C
    (43, [55, 59, 62, 67]),  # G
]
ARP = [0, 7, 12, 7, 15, 12, 7, 12]  # semitone offsets over the chord root, an octave up
CHORD_LEN = 4 * BEAT

# sections: (start, end, name); they follow the scenes of index.html
SECTIONS = [
    (0.0, 6.0, "intro"),     # harnesses, then the logos gather and the layer rises
    (6.0, 9.0, "drop"),      # the logos lock onto the layer
    (9.0, 14.5, "memory"),   # one memory: a calmer half-time groove
    (14.5, 24.5, "graph"),   # the knowledge graph: a distillation, then a search
    (24.5, 32.5, "loops"),   # the workflows; VERIFIED at 28.5
    (32.5, 38.0, "tools"),   # nine MCP servers
    (38.0, 43.0, "guards"),  # filtered, tension
    (43.0, 49.5, "more"),    # the feature cards, then the build to the end drop
    (49.5, 53.0, "end"),     # the wordmark slam
]
VERIFIED = 28.5
END_CHORD = 53.0


def section_at(t):
    for s, e, name in SECTIONS:
        if s <= t < e:
            return s, e, name
    return END_CHORD, DUR, "tail"


# kicks: half time (beats 1 and 3) in the first two intro bars and in the memory section, four on the floor elsewhere
beats = [round(i * BEAT, 6) for i in range(int(DUR / BEAT))]
kicks = []
for bt in beats:
    s, e, name = section_at(bt)
    if name == "tail":
        continue
    if name == "more" and bt >= 49.0:
        continue  # the last beat before the end drop is a snare roll only
    pos = int(round(bt / BEAT)) % 4
    half = (name == "intro" and bt < 2.0) or name == "memory"
    if half and pos in (1, 3):
        continue
    kicks.append(bt)
    kick(bt, 0.5 if name == "intro" else (0.7 if name == "guards" else (0.9 if name in ("more", "graph") else 1.0)))
    if name in ("drop", "graph", "loops", "tools", "more", "end") and pos in (1, 3):
        clap(bt)
    if name == "memory" and pos == 2:
        clap(bt, 0.85)  # half-time backbeat

# hats: 16ths in the driving sections, 8ths where the picture asks the eye to read
for i in range(int(END_CHORD / (BEAT / 4))):
    t = i * BEAT / 4
    s, e, name = section_at(t)
    pos = i % 4
    if name == "more" and t >= 48.5:
        continue
    sixteenths = name in ("drop", "loops", "more", "end") or (name == "intro" and t >= 2.0)
    if not sixteenths and pos % 2 == 1:
        continue
    hat(t, 0.55 + (0.35 if pos == 2 else 0) + (0.12 if pos == 0 else 0), pan=0.25 if pos % 2 else -0.2)
    if name in ("drop", "graph", "loops", "tools", "more", "end") and pos == 2:
        hat(t, 0.5, open_=True, pan=0.1)

# snare builds into the two drops
for t in np.arange(5.0, 5.5, BEAT / 2):
    snare(t, 0.5)
for t in np.arange(5.5, 6.0, BEAT / 4):
    snare(t, 0.6 + (t - 5.5))
for t in np.arange(47.5, 48.5, BEAT / 2):
    snare(t, 0.45)
for t in np.arange(48.5, 49.0, BEAT / 4):
    snare(t, 0.55)
for t in np.arange(49.0, 49.5, BEAT / 8):
    snare(t, 0.6 + 0.8 * (t - 49.0))

riser(4.0, 6.0, 0.9)
riser(13.5, 14.5, 0.3)
riser(23.5, 24.5, 0.3)
riser(47.0, 49.5, 1.0)

for t, g in ((6.0, 1.0), (9.0, 0.6), (14.5, 0.6), (19.5, 0.45), (24.5, 0.7), (VERIFIED, 0.8), (32.5, 0.7), (38.0, 0.5), (43.0, 0.7), (49.5, 1.0), (END_CHORD, 0.9)):
    crash(t, g)
for t, g in ((6.0, 1.0), (VERIFIED, 0.7), (49.5, 1.0), (END_CHORD, 0.8)):
    boom(t, g)

# harmony: the progression restarts at each section start, one chord per bar
for s, e, name in SECTIONS:
    t = s
    ci = 0
    while t < e - 1e-6:
        root, voicing = CHORDS[ci % 4]
        length = min(CHORD_LEN, e - t)
        if name == "intro":
            cut = 500 + 2500 * (t / 6.0)
        elif name == "guards":
            cut = 700
        else:
            cut = 4200 if name in ("drop", "end") else (3800 if name == "more" else 3400)
        pumps = [k for k in kicks if t <= k < t + length]
        pad_gain = 0.45 if name == "intro" else (0.4 if name == "guards" else (0.85 if name in ("memory", "graph") else 1.0))
        pad_chord(t, voicing, length + 0.05, cut, pad_gain, pumps)
        # bass: rolling 8ths, offbeat accent; quiet in the guards section
        for j in range(int(round(length / (BEAT / 2)))):
            bt = t + j * BEAT / 2
            if name == "loops" and VERIFIED - BEAT <= bt < VERIFIED:
                continue  # one silent beat before VERIFIED
            if name == "guards":
                continue
            onbeat = j % 2 == 0
            g = 0.55 if (name != "intro" and onbeat) else 1.0
            bcut = 380 + (900 if not onbeat else 300) if name != "intro" else 260 + 600 * (bt / 6.0)
            bass_note(bt, root - 12 if root > 44 else root, BEAT / 2 * 0.92, bcut, g)
        # arp over the chord root: 16ths in the driving sections, 8ths in the calmer ones
        sixteenths = name in ("drop", "loops", "more", "end") or (name == "intro" and t >= 2.0)
        step = BEAT / 4 if sixteenths else BEAT / 2
        steps = int(round(length / step))
        for j in range(steps):
            at = t + j * step
            off = ARP[j % len(ARP)]
            base = root + 12 + (12 if name in ("loops", "end") else 0)
            acut = 1800 + 3000 * (at / 6.0) if name == "intro" else (2600 if name == "guards" else 4200)
            pg = 0.5 if name == "guards" else (0.7 if name == "intro" else 1.0)
            pluck(at, base + off, acut, pg, pan=0.35 if j % 2 else -0.35)
        # counter line in the graph and tools sections: long saw notes a tenth above
        if name in ("graph", "tools"):
            n = idx(length)
            f = hz(voicing[-1] + 12)
            x = lp(saw(f, n) + saw(f * 1.004, n), 2600) * env(n, 0.03, length, sustain=0.7) * 0.05
            out(t, x, 1.0, pan=0.0, verb=0.5, delay=0.2)
        t += length
        ci += 1

# final chord: Am(add9) held from 43.0, ringing into the last frame
n = idx(2.0)
for note, pan in ((45, 0), (57, -0.3), (60, 0.3), (64, -0.2), (71, 0.2), (69, 0)):
    f = hz(note)
    x = lp(saw(f, n) + saw(f * 1.003, n, 0.3), 3000) * env(n, 0.005, 0.8) * 0.07
    out(END_CHORD, x, 1.0, pan=pan, verb=0.8)
kick(END_CHORD, 1.0)

# ---------------------------------------------------------------- effects returns
# reverb: decaying stereo noise impulse response
ir_n = idx(1.6)
tt = np.arange(ir_n) / SR
irl = lp(noise(ir_n), 6000) * np.exp(-tt / 0.42)
irr = lp(noise(ir_n), 6000) * np.exp(-tt / 0.42)
irl /= np.sqrt(np.sum(irl**2))
irr /= np.sqrt(np.sum(irr**2))
vl = signal.fftconvolve(hp(SENDS["verb"][0], 250), irl)[:N]
vr = signal.fftconvolve(hp(SENDS["verb"][1], 250), irr)[:N]
L += vl * 0.55
R += vr * 0.55

# ping-pong delay, 3/16 note
dtime = idx(BEAT * 0.75)
dl, dr = SENDS["delay"]
el = np.zeros(N)
er = np.zeros(N)
src_l, src_r = dl.copy(), dr.copy()
fb = 0.38
for k in range(1, 6):
    sh = dtime * k
    if sh >= N:
        break
    gk = fb ** (k - 1)
    if k % 2:
        er[sh:] += src_l[: N - sh] * gk
        el[sh:] += src_r[: N - sh] * gk
    else:
        el[sh:] += src_l[: N - sh] * gk
        er[sh:] += src_r[: N - sh] * gk
L += lp(el, 5000) * 0.45
R += lp(er, 5000) * 0.45

# ---------------------------------------------------------------- master
# tail fade over the last 0.4 s, gentle saturation, peak normalise to -6 dBFS
fade = np.ones(N)
fn = idx(0.4)
fade[-fn:] = np.linspace(1, 0, fn) ** 2
L *= fade
R *= fade
L = np.tanh(L * 1.1)
R = np.tanh(R * 1.1)
peak = max(np.max(np.abs(L)), np.max(np.abs(R)))
L *= 0.5 / peak
R *= 0.5 / peak

pcm = (np.stack([L, R], axis=1) * 32767).astype(np.int16)
out_path = sys.argv[1] if len(sys.argv) > 1 else "score.wav"
from scipy.io import wavfile

wavfile.write(out_path, SR, pcm)
print("wrote", out_path, f"{N / SR:.2f}s")
